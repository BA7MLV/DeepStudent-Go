import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudRecords } from './records.js';
import type { CloudConfiguration } from './config.js';
import { PluginFiles } from '../plugins/files.js';
import { taskDto, TASK_KINDS } from './tasks.js';
import type { RuntimeTaskSubmit } from '@wangke/contracts/client-runtime';

/** Durable admission shared by HTTP compatibility and generated commands. No
 * model is invoked here; the executor later claims the committed queue row. */
export function submitOwnerTask(store: DatabaseStore, records: CloudRecords, configuration: CloudConfiguration, owner: string, command: RuntimeTaskSubmit) {
  if (!command || !TASK_KINDS.includes(command.kind) || !command.operationId || command.operationId.length > 100 || !command.resource || command.resource.length > 256 || !command.input || Array.isArray(command.input)) throw new Error('invalid_task');
  const input: Record<string, unknown> = new PluginFiles(store).admitTask(owner, command.kind, command.input);
  const resource = ['chat', 'qa'].includes(command.kind) ? `session:${Number(input.sessionId)}` : typeof input.videoId === 'string' ? `course:${input.videoId}` : command.resource;
  return store.transaction(() => {
    const previous = store.db.prepare('SELECT * FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner, command.operationId) as { kind: string; resource: string; input: string } | undefined;
    if (previous) {
      if (previous.kind !== command.kind || previous.resource !== resource || !isDeepStrictEqual(JSON.parse(previous.input), input)) throw new Error('task_nonce_conflict');
      return taskDto(previous);
    }
    if (['chat', 'qa'].includes(command.kind) && !records.get(owner, 'chatSessions', Number(input.sessionId))) throw new Error('session_not_found');
    const active = store.db.prepare("SELECT * FROM cloud_tasks WHERE owner_id=? AND kind=? AND resource=? AND status IN ('queued','running','waiting_user')").get(owner, command.kind, resource);
    if (active && !['chat', 'qa', 'modelOnce', 'artifactEdit', 'handoutEdit'].includes(command.kind)) return taskDto(active);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)").run(id, owner, command.operationId, command.kind, resource, JSON.stringify(input), now, now);
    configuration.audit(owner, 'task.created', { id, kind: command.kind, resource });
    return taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
  });
}
