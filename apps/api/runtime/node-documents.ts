import type { TaskContext } from '../src/cloud/execution.js';
import { SystemMaterials } from '../src/storage/system-materials.js';
import { AGENTS_PATH, MCP_PATH, MEMORY_PATH, SKILLS_PATH, memoryName } from '@wangke/contracts/system';
import { boardPath } from '@wangke/contracts/board';
import { pluginPath } from '@wangke/contracts/plugins';
import { notebookRead } from '../src/agent/notebook-read.js';
import { readLearningMarkdown } from '../src/plugins/learning-files.js';
import { applyTaskEdits, assertTaskEditScope, editCourseMarkdown, withTaskEditPermission } from './task-interactions.js';

function systemPath(path: string) {
  return path === AGENTS_PATH || path === MCP_PATH || memoryName(path) || path.startsWith(`${SKILLS_PATH}/`) || boardPath(path) || pluginPath(path);
}
const systemDirectories = new Set(['/system', MEMORY_PATH, SKILLS_PATH, '/system/board', '/system/plugins', '/system/plugin-data']);

/** App resources only. No host paths, deletes, shell, global MCP changes or
 * fallback to another account/database. Models see precisely this subset. */
export async function editNodeDocument(context: TaskContext, args: Record<string, unknown>) {
  assertTaskEditScope(context);
  if (typeof args.path !== 'string') throw new Error('invalid_document_path');
  let path = args.path;
  if (context.task.kind === 'qa' && path === '/courses/current/material') path = `/courses/${encodeURIComponent(String(context.task.input.videoId))}/material`;
  if (path.startsWith('/courses/')) return editCourseMarkdown(context, { ...args, path });
  if (!systemPath(path) || path === MCP_PATH) throw new Error('native_system_edit_scope_denied');
  if (Object.keys(args).some(key => !['path', 'revision', 'create', 'content', 'edits'].includes(key)) || !Number.isSafeInteger(args.revision) || Number(args.revision) < 0) throw new Error('invalid_system_edit');
  const files = new SystemMaterials(context.store);
  if (memoryName(path) && !files.memory.isEnabled(context.owner)) throw new Error('memory_disabled');
  let original;
  try { original = files.read(context.owner, path); }
  catch (error) {
    // Only named memory notes may be created without an existing document.
    if (!memoryName(path) || args.create !== true || args.revision !== 0 || !(error instanceof Error) || error.message !== 'memory_not_found') throw error;
  }
  const before = original?.content ?? '', revision = original?.revision ?? 0;
  if (args.revision !== revision) throw new Error('system_revision_conflict');
  let content: string;
  if (args.create === true) {
    if (before !== '' || typeof args.content !== 'string' || args.edits !== undefined) throw new Error('invalid_system_create');
    content = args.content;
  } else {
    if (!original || args.create !== undefined && args.create !== false || args.content !== undefined || !Array.isArray(args.edits)) throw new Error('invalid_system_edit');
    content = applyTaskEdits(before, args.edits);
  }
  if (content.length > 100000) throw new Error('invalid_system_document');
  return withTaskEditPermission(context, args, () => {
    // This service enforces revision/bytes CAS, owner scope, memory state and
    // board/skills schema. It never accepts a filesystem destination from us.
    files.save(context.owner, path, content, before, revision, `user:chat-task:${context.task.id}`);
    return `已保存 ${path}`;
  }, true);
}

/** Return null only for paths that belong to the existing retrieval executor. */
export function readNodeDocument(context: TaskContext, args: Record<string, unknown>): string | null {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!systemPath(path) && !systemDirectories.has(path)) return null;
  context.checkActive();
  if (context.configuration.taskPolicy(context.owner, context.task.id).read !== 'allow') throw new Error('native_document_read_permission_required');
  const files = new SystemMaterials(context.store);
  if (systemDirectories.has(path)) return JSON.stringify(files.list(context.owner, path, Number(args.offset ?? 0)));
  return JSON.stringify(notebookRead(files.read(context.owner, path), args));
}

export function readRawCourse(context: TaskContext, args: Record<string, unknown>, videoId: string): string {
  context.checkActive();
  if (context.configuration.taskPolicy(context.owner, context.task.id).read !== 'allow') throw new Error('native_document_read_permission_required');
  const resources = context.pluginService?.learningOptions.resources;
  if (!resources) throw new Error('resource_service_unavailable');
  const { text, revision } = readLearningMarkdown(context.store, context.filesDir, context.owner, videoId, resources);
  // Same bounded, revision-pinned reader used by system tools. Course edits use
  // exact bytes captured by the server, not a model-supplied revision grant.
  return JSON.stringify(notebookRead({ path: `/courses/${encodeURIComponent(videoId)}/material`, name: videoId, content: text, revision: Number.parseInt(revision.slice(0, 12), 16), updatedAt: null }, args));
}
