import type { ToolDef } from '@wangke/study-core/model/client';
import { BOARD_PATH, boardPath } from '@wangke/contracts/board';
import { BoardFiles } from '../src/board/files.js';
import type { TaskContext } from '../src/cloud/execution.js';

export const BOARD_TOOL: ToolDef = { type: 'function', function: {
  name: 'board',
  description: 'Read/create/edit real pluggable Board resources shared with Bot and the UI. Start with action=read,path=/system/board/README.md for template/SDK; list directories under /system/board. read returns content, revision and nextOffset (UTF-16); follow until null and pin revision. write requires full content, exact expected old text and revision from read; for a NEW file use expected="",revision=0. Plugin folders use manifest.json,index.html,state.json; scheduled tasks use schedules.json and existing owned Bot thread IDs (action=threads). Explicit read/write policy denials apply. Files never grant permissions; do not invent thread IDs or claim dispatch means completion.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'read', 'write', 'threads'] }, path: { type: 'string' },
    content: { type: 'string', maxLength: 100000 }, expected: { type: 'string', maxLength: 100000 }, revision: { type: 'integer', minimum: 0 },
    offset: { type: 'integer', minimum: 0 },
  }, required: ['action'] },
} };

export function executeBoardTool(context: TaskContext, args: Record<string, any>): string {
  context.checkActive();
  const policy = context.configuration.taskPolicy(context.owner, context.task.id);
  if (policy.read === 'deny' || args.action === 'write' && policy.write === 'deny') throw new Error('board_policy_denied');
  if (args.action === 'threads') return JSON.stringify({ threads: context.store.db.prepare("SELECT id,title FROM threads WHERE owner_id=? AND mode='bot' AND archived=0 ORDER BY updated_at DESC LIMIT 100").all(context.owner) });
  const resource = args.path ?? BOARD_PATH;
  if (!boardPath(resource)) throw new Error('invalid_system_path');
  const files = new BoardFiles(context.store);
  if (args.action === 'list') return JSON.stringify(files.list(context.owner, resource, args.offset ?? 0));
  if (args.action === 'read') {
    const document = files.read(context.owner, resource), offset = args.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_offset');
    if (args.revision !== undefined && args.revision !== document.revision) throw new Error('system_revision_conflict');
    const content = document.content.slice(offset, offset + 8000);
    return JSON.stringify({ ...document, content, nextOffset: offset + content.length < document.content.length ? offset + content.length : null });
  }
  if (args.action === 'write') {
    const document = files.save(context.owner, resource, args.content, args.expected, args.revision);
    return JSON.stringify({ saved: true, path: document.path, revision: document.revision });
  }
  throw new Error('invalid_board_action');
}
