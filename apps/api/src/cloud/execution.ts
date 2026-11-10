import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CloudTask, CloudMutation } from '@wangke/contracts/cloud';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from './config.js';
import type { CloudRecords } from './records.js';
import { ProjectError, ProjectFiles } from '../projects/files.js';
import { ProjectRepository } from '../projects/repository.js';
import type { WebSearchService } from '../web-search/service.js';
import type { PluginService } from '../plugins/service.js';
import type { McpManager } from '../mcp/manager.js';

export type ExecutorKind = 'node';
export interface TaskContext {
  task: CloudTask;
  owner: string;
  store: DatabaseStore;
  records: CloudRecords;
  /** Accumulated receipt versions of every record this task's committed
   * mutations touched. The runner persists them at terminal states (and at
   * waiting_event suspension) so the client can reconcile exactly these keys
   * instead of a global records cycle. */
  effects: { table: string; key: string | number; revision: number }[];
  configuration: CloudConfiguration;
  filesDir: string;
  signal: AbortSignal;
  fetch: typeof fetch;
  webSearch?: WebSearchService;
  mcp?: McpManager;
  pluginService?: PluginService;
  checkActive(): void;
  report(progress: Record<string, unknown>): void;
}
export type TaskExecutor = (context: TaskContext) => Promise<unknown>;

/** All persistent cloud orchestration is server owned. Static local execution
 * is a separate adapter, never a cloud error fallback. */
export function executorFor(task: CloudTask, video: Record<string, any> | null): ExecutorKind {
  return 'node';
}

export function taskRows(context: TaskContext, table: string, field?: string, value?: unknown): Record<string, any>[] {
  const rows = context.store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL')
    .all(context.owner, table) as Array<{ value: string }>;
  return rows.map(row => JSON.parse(row.value)).filter(row => !field || row[field] === value);
}

export function recordMutation(table: string, key: string | number, before: Record<string, any> | null, after: Record<string, any> | null): CloudMutation {
  return { id: crypto.randomUUID(), table, key, before, after };
}

export function commitTask(context: TaskContext, mutations: CloudMutation[]) {
  context.checkActive();
  const linked = context.store.db.prepare('SELECT parent_run_id FROM cloud_tasks WHERE id=? AND owner_id=?').get(context.task.id, context.owner) as any;
  if (linked?.parent_run_id) {
    const policy = context.configuration.taskPolicy(context.owner, context.task.id);
    if (policy.read !== 'allow' || policy.write !== 'allow') throw new Error('bot_child_write_permission_required');
  }
  if (!mutations.length) return;
  const receipt = context.records.apply(context.owner, mutations);
  context.effects.push(...receipt.versions);
}

export function newRecordId() { return crypto.randomInt(1_000_000, 2 ** 48 - 1); }

/** Only resolve owned, server-indexed blobs, never a filename supplied in a task. */
export function taskFile(context: TaskContext, reference: unknown): string {
  const id = (reference as { $file?: unknown } | null)?.$file;
  if (typeof id !== 'string') throw new Error('文件引用不存在');
  const file = context.store.db.prepare('SELECT storage_name FROM files WHERE id=? AND owner_id=?').get(id, context.owner) as { storage_name: string } | undefined;
  if (!file) throw new Error('文件不存在');
  try {
    const root = fs.realpathSync(context.filesDir);
    const filename = fs.realpathSync(path.resolve(root, file.storage_name));
    if (!filename.startsWith(`${root}${path.sep}`)) throw new Error('文件路径无效');
    return filename;
  } catch { throw new Error('文件不可用'); }
}

/** Pin the authoritative file, including across parent renames/symlink swaps.
 * Callers close the descriptor; subprocesses inherit it rather than reopening
 * a mutable workspace path. Legacy blobs are only used for unmigrated courses. */
export function taskCourseFile(context: TaskContext, id: string) {
  const mapped = context.store.db.prepare('SELECT f.project_id,f.path FROM resource_files f JOIN projects p ON p.id=f.project_id AND p.owner_id=f.owner_id WHERE f.owner_id=? AND f.course_id=?')
    .get(context.owner, id) as { project_id: string; path: string } | undefined;
  let opened: { fd: number; size: number; revision: string };
  let legacyFileId: string | undefined;
  let files: ProjectFiles | undefined;
  const assertAccess=()=>{
    const parent=context.store.db.prepare('SELECT parent_run_id FROM cloud_tasks WHERE id=? AND owner_id=?').get(context.task.id,context.owner) as {parent_run_id:string|null}|undefined;
    if(!parent?.parent_run_id||!mapped)return;
    const thread=context.store.db.prepare('SELECT t.agent_id FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(parent.parent_run_id,context.owner) as {agent_id:string|null}|undefined;
    new ProjectRepository(context.store,path.join(context.filesDir,'projects')).authorize(context.owner,mapped.project_id,thread?.agent_id??null,'read');
  };
  assertAccess();
  if (mapped) {
    if (context.store.db.prepare('SELECT 1 FROM projects WHERE id=? AND archived=1').get(mapped.project_id)) throw new ProjectError('project_archived',409);
    if (process.platform !== 'linux' && context.store.db.prepare('SELECT 1 FROM project_executions WHERE project_id=?').get(mapped.project_id)) throw new ProjectError('project_busy', 409);
    files = new ProjectFiles(path.join(context.filesDir, 'projects'));
    try { opened = files.open(mapped.project_id, mapped.path); }
    catch (error) { if (error instanceof ProjectError && error.status === 404) return null; throw error; }
  } else {
    const edited = context.records.get(context.owner, 'files', id);
    const original = context.records.get(context.owner, 'courseFiles', id);
    if (!edited && !original) return null;
    legacyFileId = edited ? (edited.blob as { $file?: string })?.$file : String(original!.fileId);
    const filename = taskFile(context, edited ? edited.blob : { $file: original!.fileId });
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    opened = { fd, size: fs.fstatSync(fd).size, revision: '' };
  }
  let closed = false;
  return { fd: opened.fd, size: opened.size, filename: `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${opened.fd}`,
    assertCurrent() {
      context.checkActive();
      assertAccess();
      const course = context.records.get(context.owner, 'videos', id);
      if (!course || course.fileDeleted) throw new Error('course_file_unavailable');
      if (!mapped || !files) {
        const edited = context.records.get(context.owner, 'files', id), original = context.records.get(context.owner, 'courseFiles', id);
        const currentId = edited ? (edited.blob as { $file?: string })?.$file : original?.fileId;
        if (currentId !== legacyFileId) throw new Error('course_file_conflict');
        return;
      }
      const mapping = context.store.db.prepare('SELECT project_id,path FROM resource_files WHERE owner_id=? AND course_id=?').get(context.owner, id) as { project_id: string; path: string } | undefined;
       if (!mapping || mapping.project_id !== mapped.project_id || mapping.path !== mapped.path) throw new ProjectError('project_file_conflict', 409);
       if (context.store.db.prepare('SELECT 1 FROM projects WHERE id=? AND archived=1').get(mapped.project_id)) throw new ProjectError('project_archived',409);
      const current = files.open(mapped.project_id, mapped.path);
      try { if (current.revision !== opened.revision) throw new ProjectError('project_file_conflict', 409); }
      finally { fs.closeSync(current.fd); }
    },
    close() { if (!closed) { closed = true; fs.closeSync(opened.fd); } },
  };
}
