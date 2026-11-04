import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskContext } from '../src/cloud/execution.js';
import { readLearningMarkdown } from '../src/plugins/learning-files.js';
import { executeResourceCommand } from '../src/realtime/resources.js';
import { validateAskAnswer, askUserToolResult, type AskUserData } from '@wangke/study-core/ask-user';
import { folderCourseScope } from '@wangke/study-core/folder-scope';
import { taskRows } from '../src/cloud/execution.js';

/** Native tasks wait only on their own durable approval/answer records. These
 * bounded waits are not browser business-state polling or a fallback executor. */
export async function editCourseMarkdown(context: TaskContext, args: Record<string, unknown>) {
  assertTaskEditScope(context);
  if (Object.keys(args).some(key => !['path', 'edits'].includes(key))) throw new Error('invalid_course_edit');
  const match = typeof args.path === 'string' && /^\/courses\/([^/]+)\/material$/.exec(args.path);
  if (!match || !Array.isArray(args.edits) || !args.edits.length || args.edits.length > 100) throw new Error('invalid_course_edit');
  const courseId = decodeURIComponent(match[1]);
  const checkCourse = () => {
    assertTaskEditScope(context);
    const row = context.store.db.prepare('SELECT input,kind FROM cloud_tasks WHERE id=? AND owner_id=?').get(context.task.id, context.owner) as { input: string; kind: string };
    const input = JSON.parse(row.input);
    if (row.kind === 'qa' && input.videoId !== courseId) throw new Error('course_outside_task_scope');
    const session = Number.isSafeInteger(input.sessionId) ? context.records.get(context.owner, 'chatSessions', input.sessionId) : null;
    const scope = folderCourseScope(taskRows(context, 'folders'), taskRows(context, 'videos') as Array<{id:string;folderId?:number}>, session?.projectFolderId);
    if (scope && !scope.has(courseId)) throw new Error('course_outside_project_scope');
  };
  checkCourse();
  const resources = context.pluginService?.learningOptions.resources;
  if (!resources) throw new Error('resource_service_unavailable');
  const original = readLearningMarkdown(context.store, context.filesDir, context.owner, courseId, resources).text;
  const text = applyTaskEdits(original, args.edits);
  return withTaskEditPermission(context, args, id => {
    checkCourse();
    // Bind the filesystem admission/receipt to the single consumed approval.
    executeResourceCommand(resources, context.owner, { operationId: `native-edit-${id}`, operation: { kind: 'saveMarkdown', courseId, expected: original, text } });
    return `已修改 ${args.path}`;
  });
}

export function assertTaskEditScope(context: TaskContext) {
  context.checkActive();
  // BotRunner owns nested-task approvals and their exact write permits. The
  // account chat tool must not turn that into a second, unbound approval path.
  const task = context.store.db.prepare('SELECT parent_run_id,kind,status FROM cloud_tasks WHERE id=? AND owner_id=?').get(context.task.id, context.owner) as { parent_run_id: string | null; kind: string; status: string } | undefined;
  if (!task || task.parent_run_id || !['chat', 'qa'].includes(task.kind) || !['running', 'waiting_user'].includes(task.status)) throw new Error('native_edit_task_scope_denied');
  if (context.configuration.taskPolicy(context.owner, context.task.id).read !== 'allow') throw new Error('native_edit_read_permission_required');
}

export function applyTaskEdits(original: string, edits: unknown[]) {
  if (!edits.length || edits.length > 100) throw new Error('invalid_course_edit');
  let text = original;
  for (const value of edits) {
    const edit = value as { old_string: string; new_string: string; replace_all?: boolean };
    if (!edit || typeof edit.old_string !== 'string' || !edit.old_string || edit.old_string.length > 100000 || typeof edit.new_string !== 'string' || edit.new_string.length > 100000 || Object.keys(edit).some(key => !['old_string', 'new_string', 'replace_all'].includes(key))) throw new Error('invalid_course_edit');
    if (edit.replace_all !== undefined && typeof edit.replace_all !== 'boolean') throw new Error('invalid_course_edit');
    const count = text.split(edit.old_string).length - 1;
    if (!count || count !== 1 && edit.replace_all !== true) throw new Error('edit_source_not_unique');
    text = edit.replace_all === true ? text.split(edit.old_string).join(edit.new_string) : text.replace(edit.old_string, edit.new_string);
    if (text.length > 2000000) throw new Error('invalid_course_edit');
  }
  return text;
}

/** Same task-owned permission journal as Browser tools, without a second HTTP
 * authorization endpoint. System edits follow the existing no-prompt contract;
 * explicit deny and parent/task/owner checks are never waived. */
export async function withTaskEditPermission(context: TaskContext, args: Record<string, unknown>, execute: (permissionId: string) => string, system = false) {
  const id = crypto.randomUUID(), serialized = JSON.stringify(args);
  const policy = () => { assertTaskEditScope(context); return context.configuration.taskPolicy(context.owner, context.task.id).write; };
  if (policy() === 'deny') throw new Error('write_permission_denied');
  const db = context.store.db;
  db.prepare('INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,created_at,status) VALUES(?,?,?,?,?,?,?)')
    .run(id, context.owner, context.task.id, 'write', serialized, new Date().toISOString(), policy() === 'allow' || system ? 'consumed' : 'pending');
  try {
    if (policy() !== 'allow' && !system) {
      db.prepare("UPDATE cloud_tasks SET status='waiting_user' WHERE id=? AND status='running'").run(context.task.id);
      for (;;) {
        if (policy() === 'deny') throw new Error('write_permission_revoked');
        const permission = db.prepare('SELECT status FROM cloud_permissions WHERE id=? AND owner_id=? AND task_id=? AND capability=? AND arguments=?')
          .get(id, context.owner, context.task.id, 'write', serialized) as { status: string } | undefined;
        if (permission?.status === 'approved') {
          if (!db.prepare("UPDATE cloud_permissions SET status='consumed' WHERE id=? AND owner_id=? AND task_id=? AND status='approved'").run(id, context.owner, context.task.id).changes) throw new Error('permission_already_consumed');
          break;
        }
        if (permission?.status !== 'pending') throw new Error('write_permission_rejected');
        await delay(100, undefined, { signal: context.signal });
      }
    }
    if (policy() === 'deny') throw new Error('write_permission_revoked');
    context.configuration.audit(context.owner, 'permission.consumed', { id, taskId: context.task.id, system });
    return execute(id);
  } finally {
    db.prepare("UPDATE cloud_permissions SET status='finished' WHERE id=? AND status='consumed'").run(id);
    db.prepare("UPDATE cloud_permissions SET status='expired' WHERE id=? AND status IN ('pending','approved')").run(id);
    db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=? AND status='waiting_user'").run(context.task.id);
  }
}

export async function awaitTaskAnswer(context: TaskContext, ask: AskUserData) {
  const db = context.store.db;
  db.prepare("UPDATE cloud_tasks SET status='waiting_user' WHERE id=? AND status='running'").run(context.task.id);
  try {
    for (;;) {
      context.checkActive();
      const answer = context.store.transaction(() => {
        const row = db.prepare("SELECT id,value FROM cloud_task_commands WHERE task_id=? AND action='answerAsk' AND consumed=0 ORDER BY id LIMIT 1").get(context.task.id) as { id: number; value: string } | undefined;
        if (!row) return null;
        db.prepare('UPDATE cloud_task_commands SET consumed=1 WHERE id=? AND consumed=0').run(row.id);
        try { return validateAskAnswer(ask, JSON.parse(row.value)); }
        catch { return null; } // Invalid input cannot advance the model or execute a tool.
      });
      if (answer) return { answer, result: askUserToolResult(answer) };
      await delay(100, undefined, { signal: context.signal });
    }
  } finally { db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=? AND status='waiting_user'").run(context.task.id); }
}
