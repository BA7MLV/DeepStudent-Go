import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudRecords } from './records.js';
import type { CloudConfiguration } from './config.js';
import { PluginFiles } from '../plugins/files.js';
import { taskDto, TASK_KINDS } from './tasks.js';
import type { RuntimeTaskSubmit } from '@wangke/contracts/client-runtime';
import { freezeTaskModel, requireNativeTaskModel } from '../agent/task-model.js';
import { handoutEditBaseline, parseHandoutPersist } from './handout-edit.js';
import { admitContextCompression } from '../../runtime/context-compression.js';
import { parseBiliImport } from '../bilibili/input.js';
import { normalizeChatAttachments } from '../../runtime/chat-attachments.js';

/** Compare user intent, not mutable server-derived metadata or the current file
 * index. A receipt replay must not need the original to remain present forever. */
function taskIntent(input: Record<string, unknown>, kind: string) {
  const { _pluginProviders: _providers, ...intent } = input;
  if (kind === 'chat' && intent.action === 'compressContext') delete intent.compressionBaseline;
  if (kind === 'chat' && Array.isArray(intent.attachments)) intent.attachments = intent.attachments.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const file = value as Record<string, unknown>;
    return { id: file.id, serverId: file.serverId,
      ...(file.text !== undefined ? { text: file.text } : {}),
      ...(file.description !== undefined ? { description: file.description } : {}),
      ...(file.truncated !== undefined && file.truncated !== false ? { truncated: file.truncated } : {}),
      ...(!file.serverId && file.dataUrl !== undefined ? { dataUrl: file.dataUrl } : {}) };
  });
  return intent;
}

/** Durable admission shared by HTTP compatibility and generated commands. No
 * model is invoked here; the executor later claims the committed queue row. */
export function submitOwnerTask(store: DatabaseStore, records: CloudRecords, configuration: CloudConfiguration, owner: string, command: RuntimeTaskSubmit) {
  if (!command || !TASK_KINDS.includes(command.kind) || !command.operationId || command.operationId.length > 100 || !command.resource || command.resource.length > 256 || !command.input || Array.isArray(command.input)) throw new Error('invalid_task');
  const resource = ['chat', 'qa'].includes(command.kind) ? `session:${Number(command.input.sessionId)}` : typeof command.input.videoId === 'string' ? `course:${command.input.videoId}` : command.resource;
  return store.transaction(() => {
    const previous = store.db.prepare('SELECT * FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner, command.operationId) as { kind: string; resource: string; input: string } | undefined;
    if (previous) {
      const previousInput = JSON.parse(previous.input);
      if (previous.kind !== command.kind || previous.resource !== resource || !isDeepStrictEqual(taskIntent(previousInput, command.kind), taskIntent(command.input, command.kind))) throw new Error('task_nonce_conflict');
      return taskDto(previous);
    }
    // Validate the new request after durable nonce lookup: retrying a completed
    // operation must return its old receipt even after history has moved on.
    const input: Record<string, unknown> = new PluginFiles(store).admitTask(owner, command.kind, command.input);
    if (command.kind === 'chat' && input.attachments !== undefined) input.attachments = normalizeChatAttachments(store, owner, input.attachments);
    if (command.kind === 'bilibiliImport') {
      const bili = parseBiliImport(input);
      if (bili.folderId !== undefined && !store.db.prepare('SELECT 1 FROM resource_folders WHERE owner_id=? AND folder_id=?').get(owner, bili.folderId)) throw new Error('invalid_bilibili_folder');
      const queued = store.db.prepare("SELECT COUNT(*) AS n FROM cloud_tasks WHERE owner_id=? AND kind='bilibiliImport' AND status IN ('queued','running')").get(owner) as { n: number };
      if (queued.n >= 4) throw new Error('bilibili_import_queue_full');
    }
    if (command.kind === 'chat' && input.action === 'compressContext') input.compressionBaseline = admitContextCompression(records, owner, command.input).compressionBaseline;
    if (command.kind === 'handoutEdit' && input.action === 'persist') handoutEditBaseline(records, owner, parseHandoutPersist(input));
    const session = ['chat', 'qa'].includes(command.kind) ? records.get(owner, 'chatSessions', Number(input.sessionId)) : undefined;
    if (['chat', 'qa'].includes(command.kind) && (!session || session.archived)) throw new Error('session_not_found');
    const active = store.db.prepare("SELECT * FROM cloud_tasks WHERE owner_id=? AND kind=? AND resource=? AND status IN ('queued','running','waiting_user')").get(owner, command.kind, resource);
    if (active && !['chat', 'qa', 'modelOnce', 'artifactEdit', 'handoutEdit', 'bilibiliImport'].includes(command.kind)) return taskDto(active);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)").run(id, owner, command.operationId, command.kind, resource, JSON.stringify(input), now, now);
    if (['chat', 'qa', 'modelOnce', 'artifactEdit', 'handoutEdit', 'cards', 'comments', 'danmaku', 'handout'].includes(command.kind) && !(command.kind === 'handoutEdit' && input.action === 'persist')) {
      const explicit = input.modelSelection ?? (input.modelRef ? { modelRef: input.modelRef } : command.kind === 'modelOnce' && input.providerId && input.model ? { modelRef: { providerId: input.providerId, model: input.model } } : undefined);
      const frozen = freezeTaskModel(store, owner, configuration.get(owner), 'chat', explicit, session?.defaultModel, input.thinkingLevel);
      requireNativeTaskModel(frozen);
      store.db.prepare('UPDATE cloud_tasks SET model_snapshot=? WHERE id=?').run(JSON.stringify(frozen), id);
    }
    configuration.audit(owner, 'task.created', { id, kind: command.kind, resource });
    return taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
  });
}
