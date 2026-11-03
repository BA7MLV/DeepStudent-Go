import crypto from 'node:crypto';
import { CloudRecords } from '../cloud/records.js';
import { executorFor } from '../cloud/execution.js';
import { taskDto } from '../cloud/tasks.js';
import type { PluginActionContext, PluginService } from './service.js';

/** Thin dispatch adapters: the existing task executors own all business writes. */
export function registerMaterialActions(service: PluginService, resolveMaterial: (args: Record<string, any>, context: PluginActionContext) => string) {
  const { store } = service, records = new CloudRecords(store);
  const properties = { materialId: { type: 'string', minLength: 1, maxLength: 256 }, clientNonce: { type: 'string', minLength: 1, maxLength: 100 } };
  const kinds = ['handout', 'comments', 'danmaku', 'transcribe', 'material', 'cover'] as const;
  for (const kind of kinds) service.register({
    id: `material.${kind}`, capability: 'learning', access: 'write',
    schema: { type: 'object', properties: { ...properties, ...(kind === 'cover' ? { force: { type: 'boolean' } } : {}) }, required: ['materialId', 'clientNonce'], additionalProperties: false },
    run: (a, c) => {
      const materialId = resolveMaterial(a, c), video = records.get(c.owner, 'videos', materialId)!;
      const format = video.materialFormat;
      if (kind === 'material' && (video.kind !== 'material' || !['md', 'docx', 'pdf'].includes(format))) throw new Error('plugin_material_format_unsupported');
      if (kind === 'transcribe' && video.kind === 'material') throw new Error('plugin_media_required');
      const input = { videoId: materialId, ...(kind === 'material' ? { format } : {}), ...(kind === 'handout' && video.kind === 'material' ? { botStudyText: true } : {}), ...(kind === 'cover' ? { options: { force: a.force ?? false } } : {}) };
      const actionId = `material.${kind}`, request = JSON.stringify({ materialId, input });
      const nonce = `plugin:${crypto.createHash('sha256').update(JSON.stringify([c.plugin.id, c.instance.id, actionId, a.clientNonce])).digest('hex')}`;
      return store.transaction(() => {
        const previous = store.db.prepare('SELECT t.*,l.request FROM cloud_tasks t JOIN plugin_learning_tasks l ON l.task_id=t.id WHERE t.owner_id=? AND t.nonce=?').get(c.owner, nonce) as any;
        if (previous) {
          if (previous.request !== request) throw new Error('plugin_nonce_conflict');
          return { ...taskDto(previous), executor: executorFor(taskDto(previous), video) };
        }
        if (store.db.prepare("SELECT 1 FROM cloud_tasks WHERE owner_id=? AND kind=? AND resource=? AND status IN ('queued','running','waiting_user')").get(c.owner, kind, `course:${materialId}`)) throw new Error('plugin_generation_conflict');
        const id = crypto.randomUUID(), now = new Date().toISOString();
        store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)").run(id, c.owner, nonce, kind, `course:${materialId}`, JSON.stringify(service.files.admitTask(c.owner, kind, input)), now, now);
        store.db.prepare('INSERT INTO plugin_learning_tasks(task_id,owner_id,plugin_id,instance_id,action_id,material_id,request) VALUES(?,?,?,?,?,?,?)').run(id, c.owner, c.plugin.id, c.instance.id, actionId, materialId, request);
        const task = taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
        return { ...task, executor: executorFor(task, video) };
      });
    },
  });
}
