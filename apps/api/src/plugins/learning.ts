import { taskDto } from '../cloud/tasks.js';
import type { PluginActionContext, PluginService } from './service.js';
import { ensureLearningResults, reconcileLearningResults } from './learning-results.js';
import { startNotebookDelivery } from './practice.js';
import { reconcilePracticeExtractions } from './practice-extraction.js';

const material = { type: 'string', minLength: 1, maxLength: 256 };
const schema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export function materialResolver(service: PluginService) {
  return (args: Record<string, any>, c: PluginActionContext) => {
    const id = args.materialId ?? (c.instance.scope.kind === 'material' ? c.instance.scope.id : undefined);
    if (typeof id !== 'string' || !id) throw new Error('plugin_material_required');
    if (c.instance.scope.kind === 'material' && id !== c.instance.scope.id) throw new Error('plugin_material_denied');
    const projectId = service.files.materialProject(c.owner, id);
    if (c.instance.scope.kind === 'project' && projectId !== c.instance.scope.id) throw new Error('plugin_material_denied');
    return id;
  };
}
/** Host domain services and delivery outlive every account's installed UI/providers. */
export function registerLearningPersistence(service: PluginService) {
  const { store } = service, resolveMaterial = materialResolver(service);
  ensureLearningResults(store);
  service.register({ id: 'learning.materials', capability: 'learning', access: 'read', schema: schema({}), run: (_, c) => {
    const rows = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='videos' AND value IS NOT NULL ORDER BY revision DESC LIMIT 1000").all(c.owner) as { value: string }[];
    return { materials: rows.map(r => JSON.parse(r.value)).filter(r => {
      try { resolveMaterial({ materialId: r.id }, c); return true; } catch { return false; }
    }).map(r => ({ id: r.id, name: r.name })) };
  } });
  service.register({ id: 'learning.results', capability: 'learning', access: 'read', schema: schema({ materialId: material }, []), run: (a, c) => {
    const id = resolveMaterial(a, c);
    const rows = store.db.prepare(`SELECT t.*,l.action_id,l.result AS artifacts,l.delivered_at,l.error AS delivery_error FROM plugin_learning_tasks l
      JOIN cloud_tasks t ON t.id=l.task_id AND t.owner_id=l.owner_id WHERE l.owner_id=? AND l.plugin_id=? AND l.instance_id=? AND l.material_id=? ORDER BY t.created_at DESC LIMIT 50`).all(c.owner, c.plugin.id, c.instance.id, id) as any[];
    return { tasks: rows.map(r => ({ ...taskDto(r), origin: { pluginId: c.plugin.id, instanceId: c.instance.id, actionId: r.action_id, contextRef: { materialId: id } }, artifacts: r.artifacts ? JSON.parse(r.artifacts) : null, deliveredAt: r.delivered_at, deliveryError: r.delivery_error })) };
  } });
  reconcilePracticeExtractions(service); reconcileLearningResults(store);
  const stopPractice = startNotebookDelivery(service);
  const timer = setInterval(() => { try { reconcilePracticeExtractions(service); reconcileLearningResults(store); } catch { console.error('plugin_result_delivery_unavailable'); } }, 1000); timer.unref();
  return async () => { clearInterval(timer); await stopPractice(); };
}
