import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { RuntimeRead } from '@wangke/contracts/client-runtime';
import type { DatabaseStore } from '../storage/database.js';
import type { PluginService } from '../plugins/service.js';
import type { ResourceFiles } from '../projects/resources.js';
import { SystemMaterials } from '../storage/system-materials.js';
import { taskDto, listOwnerTasks } from '../cloud/tasks.js';
import { inspectInteraction } from './interaction-recovery.js';
import { preferencesProjection } from './preferences.js';

export interface RuntimeChange { revision: number; owner_id: string; domain: string; entity: string }
type ReadKind = RuntimeRead['kind'];
type ReadHandlers = { [K in ReadKind]: {
  read(owner: string, request: Extract<RuntimeRead, { kind: K }>): unknown;
  matches(request: Extract<RuntimeRead, { kind: K }>, change: RuntimeChange): boolean;
} };
type Ports = {
  store: DatabaseStore; plugins: PluginService; resources?: ResourceFiles;
  recordsPage(owner: string, after: number): unknown;
  sessionProjection(owner: string, request: Extract<RuntimeRead, { kind: 'session' }>): unknown;
  canonical(value: unknown): string;
};
const catalogChanged = (change: RuntimeChange) => ['projects', 'resource_trash', 'resource_files', 'resource_folders'].includes(change.domain)
  || change.domain === 'cloud_records' && change.entity.startsWith('videos:')
  || change.domain === 'system_file_entries' && !change.entity.startsWith('/system/plugin-data/') && !/\/(state|schedules)\.json$/.test(change.entity);
const inDomains = (change: RuntimeChange, domains: string[]) => domains.includes(change.domain);

/** Explicit product assembly, not a registration/DI framework. Each read owns its
 * invalidation rule; transport, identity, snapshots and durable receipts stay in
 * ClientRuntimeDomain. The mapped type makes a new read kind a compile error here. */
export function assembleRuntimeDomains(ports: Ports) {
  const handlers: ReadHandlers = {
    ...pluginReads(ports), ...resourceReads(ports), ...activityReads(ports), ...recordReads(ports),
  };
  // Correlated union dispatch: the public RuntimeRead discriminant selects the
  // matching parameter type. Keep this cast at the single assembly boundary.
  const select = (request: RuntimeRead) => handlers[request.kind] as {
    read(owner: string, request: RuntimeRead): unknown;
    matches(request: RuntimeRead, change: RuntimeChange): boolean;
  };
  return {
    read: (owner: string, request: RuntimeRead) => select(request).read(owner, request),
    matches: (request: RuntimeRead, change: RuntimeChange) => select(request).matches(request, change),
  };
}

function pluginReads({ plugins, canonical }: Ports): Pick<ReadHandlers, 'catalog' | 'plugin' | 'pluginQueries'> {
  const changed = (request: Extract<RuntimeRead, { kind: 'plugin' | 'pluginQueries' }>, change: RuntimeChange) => {
    if (catalogChanged(change)) return true; // Revocation never cancels accepted work.
    if (request.kind === 'plugin' && (request.method === 'state.read' || request.method === 'schedules.read')) {
      return change.domain === 'system_file_entries' && change.entity === plugins.files.statePath(change.owner_id, request.pluginId, request.instanceId, request.method === 'state.read' ? 'state' : 'schedules');
    }
    return inDomains(change, ['cloud_records', 'cloud_tasks', 'runs', 'run_steps', 'messages', 'threads', 'system_file_entries', 'plugin_learning_tasks', 'plugin_learning_receipts', 'plugin_practice_snapshots', 'plugin_practice_submissions']);
  };
  const read = async (owner: string, request: Extract<RuntimeRead, { kind: 'plugin' | 'pluginQueries' }>) => {
    const validations: Array<() => void> = [];
    const query = async (method: string, args: Record<string, any>) => {
      const entry = plugins.resolve(owner, request.pluginId, request.instanceId, method);
      if (entry.handler.access !== 'read') throw new RemoteError('client/forbidden', 'Only declared queries may be observed', {});
      const result = await plugins.invoke(owner, request.pluginId, request.instanceId, request.revision, method, args);
      const validate = () => {
        const current = plugins.resolve(owner, request.pluginId, request.instanceId, method);
        if (current.incarnation !== entry.incarnation || current.plugin.revision !== request.revision || canonical(current.instance) !== canonical(entry.instance)) throw new Error('plugin_changed');
      };
      validate(); validations.push(validate);
      return result;
    };
    let result: unknown;
    if (request.kind === 'pluginQueries') {
      if (!request.queries.length || request.queries.length > 8 || new Set(request.queries.map(q => q.key)).size !== request.queries.length || request.queries.some(q => !/^[a-zA-Z0-9_-]{1,40}$/.test(q.key))) throw new Error('invalid_plugin_queries');
      result = Object.fromEntries(await Promise.all(request.queries.map(async q => [q.key, await query(q.method, q.args)] as const)));
    } else result = await query(request.method, request.args);
    // Every composite member is reauthorized together after all awaits.
    for (const validate of validations) validate();
    return result;
  };
  return {
    catalog: { read: owner => ({ plugins: plugins.files.catalog(owner), layout: plugins.files.layout(owner), scopes: plugins.files.scopeCatalog(owner), services: plugins.definitions(owner) }), matches: (_, change) => catalogChanged(change) },
    plugin: { read, matches: changed }, pluginQueries: { read, matches: changed },
  };
}

function resourceReads({ store, resources }: Ports): Pick<ReadHandlers, 'systemDocument' | 'systemDirectory' | 'courseDocument' | 'resources' | 'resourceTrash'> {
  const files = () => { if (!resources) throw new Error('resource_domain_unavailable'); return resources; };
  const systemChanged = (_: unknown, change: RuntimeChange) => inDomains(change, ['system_file_entries', 'systemDocument', 'cloud_records']);
  return {
    systemDocument: { read: (owner, request) => new SystemMaterials(store).read(owner, request.path), matches: systemChanged },
    systemDirectory: { read: (owner, request) => new SystemMaterials(store).list(owner, request.path, request.offset, request.query), matches: systemChanged },
    courseDocument: { read: (owner, request) => { const resource = files(), mapped = resource.course(owner, request.courseId); return resource.projects.files.read(mapped.project_id, mapped.path); }, matches: (_, change) => inDomains(change, ['resources', 'projects', 'resource_files', 'resource_trash', 'cloud_records']) },
    resources: { read: (owner, request) => { const resource = files(); return JSON.parse(JSON.stringify(request.folderId === undefined ? resource.list(owner, request.projectId, request.path, request.archived) : resource.listFolder(owner, request.folderId))); }, matches: (_, change) => inDomains(change, ['resources', 'projects', 'resource_files', 'resource_folders', 'resource_trash', 'cloud_records']) },
    resourceTrash: { read: owner => ({ projects: files().trashList(owner) }), matches: (_, change) => inDomains(change, ['resource_trash', 'projects']) },
  };
}

function activityReads({ store }: Ports): Pick<ReadHandlers, 'permissions' | 'interactionRecovery' | 'executorRecovery' | 'task' | 'tasks'> {
  return {
    permissions: { read: owner => ({ permissions: store.db.prepare('SELECT id,task_id AS taskId,capability,arguments,status,created_at AS createdAt FROM cloud_permissions WHERE owner_id=? ORDER BY created_at DESC LIMIT 100').all(owner) }), matches: (_, change) => change.domain === 'cloud_permissions' },
    interactionRecovery: { read: (owner, request) => inspectInteraction(store, owner, request.taskId, request.sequence), matches: (_, change) => catalogChanged(change) || inDomains(change, ['cloud_records', 'cloud_tasks', 'runs', 'run_steps', 'messages', 'threads', 'system_file_entries', 'plugin_learning_tasks', 'plugin_learning_receipts', 'plugin_practice_snapshots', 'plugin_practice_submissions']) },
    executorRecovery: {
      read: (owner, request) => {
        if (request.operationIds.length > 20000 || request.operationIds.some(id => !id || id.length > 200)) throw new Error('invalid_recovery_operations');
        const task = request.taskId ? store.db.prepare('SELECT * FROM cloud_tasks WHERE owner_id=? AND id=?').get(owner, request.taskId) : undefined;
        return { task: task ? taskDto(task) : null, operations: request.operationIds.map(id => ({ id, committed: !!store.db.prepare('SELECT 1 FROM cloud_operations WHERE owner_id=? AND id=?').get(owner, id) })) };
      }, matches: (_, change) => inDomains(change, ['cloud_tasks', 'cloud_records']),
    },
    tasks: { read: owner => ({ tasks: listOwnerTasks(store, owner, 'activity') }), matches: (_, change) => inDomains(change, ['cloud_tasks', 'threads', 'agent_profiles']) },
    task: { read: (owner, request) => { const row = store.db.prepare('SELECT * FROM cloud_tasks WHERE owner_id=? AND id=?').get(owner, request.taskId); if (!row) throw new Error('task_not_found'); return taskDto(row); }, matches: (request, change) => ['cloud_tasks', 'cloud_task_progress'].includes(change.domain) && change.entity === request.taskId },
  };
}

function recordReads({ store, recordsPage, sessionProjection }: Ports): Pick<ReadHandlers, 'preferences' | 'records' | 'fileIntents' | 'session'> {
  return {
    preferences: { read: owner => preferencesProjection(store, owner), matches: (_, change) => change.domain === 'cloud_records' && change.entity.startsWith('preferences:') || change.domain === 'system_file_entries' && change.entity === '/system/AGENTS.md' },
    records: { read: (owner, request) => recordsPage(owner, request.after), matches: (_, change) => change.domain === 'cloud_records' },
    fileIntents: { read: owner => ({ intents: store.db.prepare("SELECT id,path,created_at AS createdAt FROM system_file_intents WHERE owner_id=? AND status='conflict' ORDER BY created_at,id LIMIT 100").all(owner) }), matches: (_, change) => change.domain === 'system_file_entries' },
    session: { read: sessionProjection, matches: (request, change) => change.domain === 'chat_session' && change.entity === String(request.sessionId) },
  };
}
