import { Ajv, type ValidateFunction } from 'ajv';
import { PluginRegistry, type PluginDispose } from '@wangke/contracts/plugin-registry';
import type { PluginCapability, PluginInstance, PluginPackage } from '@wangke/contracts/plugins';
import { PLUGINS_TOOL, PLUGIN_LAYOUT_PATH, PLUGIN_SURFACES } from '@wangke/contracts/plugins';
import type { DatabaseStore } from '../storage/database.js';
import type { BotApplicationService } from '../agent/service.js';
import type { CloudTaskRunner } from '../cloud/tasks.js';
import { BoardTasks } from '../board/tasks.js';
import { PluginFiles } from './files.js';
import { registerLearningPersistence } from './learning.js';
import { registerNativeProviders } from './providers/index.js';
import type { ResourceFiles } from '../projects/resources.js';
import path from 'node:path';
import type { BoardTask } from '@wangke/contracts/board';

export interface PluginActionContext { owner: string; plugin: PluginPackage; instance: PluginInstance; projectId?: string; checkActive(): void }
export interface PluginActionHandler {
  id: string; capability: PluginCapability; schema: Record<string, unknown>;
  trustedOnly?: boolean;
  /** Audited synchronous SQL/intent-only handler; never network/process effects. */
  atomic?: 'sqlite';
  provider?: string;
  access: 'read' | 'write'; run(args: Record<string, any>, context: PluginActionContext): unknown;
}
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string', minLength: 1, maxLength: 200 };
const snapshotWrite = object({ data: {}, expected: { type: 'string', maxLength: 100000 }, revision: { type: 'integer', minimum: 0 } });

/** HTTP, Chat and Bot use this boundary. Only trusted host handlers compile schemas. */
export class PluginService {
  readonly files: PluginFiles;
  readonly registry = new PluginRegistry();
  private readonly schemas = new Ajv({ strict: true, ownProperties: true, allErrors: false, addUsedSchema: false });
  private readonly actions = new Map<string, { handler: PluginActionHandler; validate: ValidateFunction; incarnation: symbol }>();
  private readonly effects: PluginDispose[] = [];
  private readonly validateTool = this.schemas.compile<Record<string, any>>(PLUGINS_TOOL.function.parameters);
  private readonly learningCleanup: () => Promise<void>;
  private registeringProvider?: string;
  private readonly providers = new Map<string, PluginPackage>();
  private readonly knownProviders = new Map<string, PluginPackage>();
  private readonly accounts = new Map<string, { signature: string; registry: PluginRegistry; dispose: PluginDispose[] }>();
  constructor(readonly store: DatabaseStore, bots?: BotApplicationService, runner?: CloudTaskRunner, readonly learningOptions: { filesDir: string; resources?: ResourceFiles } = { filesDir: process.env.FILES_DIR ?? path.resolve(process.env.DATA_DIR ?? 'data', 'files') }) {
    this.files = new PluginFiles(store, learningOptions.resources?.projects, learningOptions.filesDir);
    this.files.nativeAvailable = id => this.providers.has(id);
    this.files.nativePackages = () => [...this.knownProviders.values()];
    const tasks = new BoardTasks(store);
    const taskAllowed = (task: BoardTask, c: PluginActionContext) => {
      if (c.instance.scope.kind === 'account') return true;
      if (task.kind === 'bot') {
        const thread = this.files.projects.thread(task.threadId);
        return thread.owner_id === c.owner && c.instance.scope.kind === 'project' && thread.project_id === c.instance.scope.id;
      }
      const row = store.db.prepare('SELECT input FROM cloud_tasks WHERE id=? AND owner_id=?').get(task.id, c.owner) as { input: string } | undefined;
      const id = row && JSON.parse(row.input).videoId;
      if (typeof id !== 'string') return false;
      try { return c.instance.scope.kind === 'material' ? id === c.instance.scope.id : this.files.materialProject(c.owner, id) === c.instance.scope.id; } catch { return false; }
    };
    const scopedTask = (c: PluginActionContext, id: unknown) => { const task = tasks.get(c.owner, id); if (!taskAllowed(task, c)) throw new Error('plugin_task_denied'); return task; };
    this.effects.push(this.registry.register({ id: 'storage', setup: ctx => ctx.provide('storage', { version: 1, value: this.files }) }));
    for (const kind of ['state', 'schedules'] as const) {
      this.register({ id: `${kind}.read`, capability: kind, access: 'read', schema: object({}), run: (_, c) => this.files.readState(c.owner, c.plugin.id, c.instance.id, kind) });
      this.register({ id: `${kind}.write`, capability: kind, access: 'write', atomic: 'sqlite', schema: snapshotWrite, run: (a, c) => this.files.writeState(c.owner, c.plugin.id, c.instance.id, kind, a.data, a.expected, a.revision) });
    }
    this.register({ id: 'schedules.threads', capability: 'schedules', access: 'read', schema: object({}), run: (_, c) => ({ threads: store.db.prepare("SELECT id,title,project_id FROM threads WHERE owner_id=? AND mode='bot' AND archived=0 ORDER BY updated_at DESC LIMIT 200").all(c.owner).filter((t: any) => c.instance.scope.kind === 'account' || c.instance.scope.kind === 'project' && t.project_id === c.instance.scope.id) }) });
    this.register({ id: 'tasks.list', capability: 'tasks', access: 'read', schema: object({}), run: (_, c) => ({ tasks: tasks.list(c.owner).filter(task => taskAllowed(task, c)) }) });
    this.register({ id: 'tasks.get', capability: 'tasks', access: 'read', schema: object({ id: text }), run: (a, c) => scopedTask(c, a.id) });
    this.register({ id: 'tasks.open', capability: 'tasks', access: 'read', schema: object({ id: text }), run: (a, c) => { const task = scopedTask(c, a.id); if (task.kind !== 'bot') throw new Error('invalid_bot_task'); return { threadId: task.threadId }; } });
    if (bots) this.register({ id: 'tasks.start', capability: 'tasks', access: 'write', schema: object({ threadId: text, prompt: { type: 'string', minLength: 1, maxLength: 12000 }, clientNonce: { type: 'string', minLength: 1, maxLength: 100 } }), run: (a, c) => {
      if (c.instance.scope.kind !== 'account') {
        const thread = this.files.projects.thread(a.threadId);
        if (thread.owner_id !== c.owner || c.instance.scope.kind !== 'project' || thread.project_id !== c.instance.scope.id) throw new Error('plugin_project_thread_denied');
      }
      return tasks.start(c.owner, `${c.plugin.id}\0${c.instance.id}`, bots, a);
    } });
    if (bots && runner) this.register({ id: 'tasks.cancel', capability: 'tasks', access: 'write', schema: object({ id: text }), run: async (a, c) => {
      const task = scopedTask(c, a.id);
      if (task.kind === 'bot') bots.cancelRun(c.owner, task.runId);
      else { store.db.prepare("UPDATE cloud_tasks SET status='cancelled',updated_at=? WHERE id=? AND owner_id=? AND status IN ('queued','running','waiting_user')").run(new Date().toISOString(), task.id, c.owner); await runner.cancel(task.id); }
      return { cancelled: tasks.get(c.owner, task.id).status === 'cancelled' };
    } });
    this.learningCleanup = registerLearningPersistence(this);
    registerNativeProviders(this);
  }
  register(handler: PluginActionHandler): PluginDispose {
    handler = { ...handler, provider: handler.provider ?? this.registeringProvider };
    if (this.actions.has(handler.id) || !/^[a-z][a-z0-9_.-]{0,99}$/.test(handler.id)) throw new Error('plugin_action_conflict');
    const validate = this.schemas.compile(handler.schema);
    const off = this.registry.register({ id: `action-${handler.id}`, requires: { storage: 1 }, setup: ctx => {
      ctx.provide(`action.${handler.id}`, { version: 1, value: handler });
      this.actions.set(handler.id, { handler, validate, incarnation: Symbol(handler.id) });
      ctx.effect(() => this.actions.delete(handler.id));
    } });
    this.effects.push(off); return off;
  }
  registerProvider(pkg: PluginPackage, setup: () => void): PluginDispose {
    if (this.providers.has(pkg.id)) throw new Error('plugin_provider_conflict');
    const before = this.effects.length;
    this.providers.set(pkg.id, pkg); this.knownProviders.set(pkg.id, pkg); this.registeringProvider = pkg.id;
    try { setup(); } catch (error) { for (const off of this.effects.splice(before).reverse()) off(); this.providers.delete(pkg.id); throw error; } finally { this.registeringProvider = undefined; }
    const owned = this.effects.splice(before);
    let disposed = false;
    const off = () => { if (disposed) return; disposed = true; for (const dispose of owned.splice(0).reverse()) dispose(); this.providers.delete(pkg.id); this.releaseAccounts(); };
    this.effects.push(off); return off;
  }
  private releaseAccounts() { for (const account of this.accounts.values()) for (const off of account.dispose.reverse()) off(); this.accounts.clear(); }
  private account(owner: string, packages = this.files.catalog(owner)) {
    const signature = JSON.stringify(packages.map(p => [p.id, p.source, p.revision, p.manifest?.enabled, p.error]));
    const previous = this.accounts.get(owner);
    if (previous?.signature === signature) return previous.registry;
    if (previous) for (const off of previous.dispose.reverse()) off();
    const registry = new PluginRegistry(), dispose: PluginDispose[] = [];
    dispose.push(registry.register({ id: 'host-learning-data', setup: ctx => ctx.provide('host.learning-data', { version: 1, value: { store: this.store, files: this.files } }) }));
    // These are account-scoped activation handles, not global native code unloading.
    for (const pkg of packages.filter(p => !p.error && p.manifest?.enabled)) {
      dispose.push(registry.register({ id: pkg.id, requires: { ...pkg.manifest!.requires, ...Object.fromEntries(Object.entries(pkg.manifest!.services ?? {}).map(([id, version]) => [`host.${id}`, version])) }, setup: ctx => {
        if (pkg.source === 'builtin' && !this.providers.has(pkg.id)) throw new Error('plugin_provider_unavailable');
        ctx.provide(pkg.id, { version: Number.parseInt(pkg.manifest!.version, 10), value: pkg });
        if (pkg.source === 'builtin') for (const { handler } of this.actions.values()) if (handler.provider === pkg.id) ctx.provide(`action.${handler.id}`, { version: 1, value: handler });
      } }));
    }
    this.accounts.set(owner, { signature, registry, dispose }); return registry;
  }
  private allowed(owner: string, plugin: PluginPackage & { manifest: NonNullable<PluginPackage['manifest']> }, handler: PluginActionHandler, registry = this.account(owner)) {
    if (!registry.status(plugin.id)?.active) throw new Error('plugin_provider_unavailable');
    if (!plugin.manifest.capabilities.includes(handler.capability)) throw new Error('plugin_capability_denied');
    const sdk = ['state', 'tasks', 'schedules'].includes(handler.capability);
    if (!sdk && !Object.values(plugin.manifest.actions ?? {}).some(a => a.service === handler.id)) throw new Error('plugin_method_undeclared');
    if (handler.capability === 'learning' && !plugin.manifest.services?.['learning-data']) throw new Error('plugin_service_dependency_undeclared');
    if (handler.trustedOnly && plugin.source !== 'builtin') throw new Error('plugin_trusted_view_required');
    if (handler.provider) {
      const provider = registry.get<PluginPackage>(handler.provider);
      if (!provider || provider.source !== 'builtin' || !registry.get(`action.${handler.id}`)) throw new Error('plugin_provider_unavailable');
      if (!(plugin.source === 'builtin' && plugin.id === handler.provider) && !plugin.manifest.requires?.[handler.provider]) throw new Error('plugin_dependency_undeclared');
    }
  }
  definitions(owner?: string, plugin?: PluginPackage & { manifest: NonNullable<PluginPackage['manifest']> }) {
    const registry = owner ? this.account(owner) : undefined;
    const packages = owner ? plugin ? [plugin] : this.files.catalog(owner) : [];
    return this.availableDefinitions(owner, packages, registry);
  }
  private availableDefinitions(owner: string | undefined, packages: PluginPackage[], registry: PluginRegistry | undefined) {
    return [...this.actions.values()].filter(({ handler }) => {
      if (!owner) return true;
      return packages.some(p => { if (p.error || !p.manifest?.enabled) return false; try { this.allowed(owner, p as PluginPackage & { manifest: NonNullable<PluginPackage['manifest']> }, handler, registry); return true; } catch { return false; } });
    }).map(({ handler: { id, schema, capability, access, trustedOnly, provider } }) => ({ id, schema, capability, access, provider, trustedOnly: !!trustedOnly }));
  }
  resolve(owner: string, pluginId: string, instanceId: string, method: string) {
    const { plugin, instance } = this.files.instance(owner, pluginId, instanceId);
    const entry = this.actions.get(method);
    if (!entry || !this.registry.get(`action.${method}`)) throw new Error('plugin_method_unavailable');
    this.allowed(owner, plugin, entry.handler);
    return { ...entry, plugin, instance };
  }
  invoke(owner: string, pluginId: string, instanceId: string, revision: number, method: string, args: Record<string, unknown>, checkActive = () => {}) {
    return this.prepareInvocation(owner, pluginId, instanceId, revision, method, args, checkActive)();
  }
  prepareInvocation(owner: string, pluginId: string, instanceId: string, revision: number, method: string, args: Record<string, unknown>, checkActive = () => {}) {
    checkActive();
    const { handler, validate, plugin, instance } = this.resolve(owner, pluginId, instanceId, method);
    if (plugin.revision !== revision) throw new Error('plugin_changed');
    if (JSON.stringify(args).length > 128000 || !validate(args)) throw new Error('invalid_plugin_arguments');
    const projectId = instance.scope.kind === 'project' ? instance.scope.id : instance.scope.kind === 'material' ? this.files.materialProject(owner, instance.scope.id) : undefined;
    return Object.assign(() => {
      checkActive();
      return handler.run(args, { owner, plugin, instance, projectId, checkActive });
    }, { atomic: handler.atomic });
  }
  invokeNamed(owner: string, pluginId: string, instanceId: string, revision: number, actionId: string, args: Record<string, unknown>, checkActive = () => {}) {
    return this.prepareNamedInvocation(owner, pluginId, instanceId, revision, actionId, args, checkActive)();
  }
  prepareNamedInvocation(owner: string, pluginId: string, instanceId: string, revision: number, actionId: string, args: Record<string, unknown>, checkActive = () => {}) {
    const { plugin } = this.files.instance(owner, pluginId, instanceId);
    const action = plugin.manifest.actions?.[actionId];
    if (!action) throw new Error('plugin_action_not_found');
    // The compiled host handler's schema remains authoritative, never a package's claimed schema.
    return this.prepareInvocation(owner, pluginId, instanceId, revision, action.service, args, checkActive);
  }
  tool(owner: string, args: Record<string, any>, checkActive = () => {}) {
    checkActive();
    if (!this.validateTool(args)) throw new Error('invalid_plugin_arguments');
    if (args.operation === 'list') {
      // One synchronous disk snapshot per list operation, not a full recursive
      // catalog scan per package. Never retain this across an await or request.
      const packages = this.files.catalog(owner), registry = this.account(owner, packages);
      return {
      plugins: packages.map(p => {
        const active = p.manifest?.enabled && !p.error;
        const methods = new Set(active ? this.availableDefinitions(owner, [p], registry).map(d => d.id) : []);
        return { id: p.id, source: p.source, revision: p.revision, error: p.error, installation: p.installation, provider: p.provider, name: p.manifest?.name, enabled: p.manifest?.enabled, views: active ? p.manifest!.views : {}, contributions: active ? p.manifest!.contributions : {}, dependencies: p.dependencies, actions: Object.entries(p.manifest?.actions ?? {}).filter(([, a]) => methods.has(a.service)).map(([id, a]) => ({ id, title: a.title })) };
      }),
      layout: JSON.parse(this.files.layout(owner).content), surfaces: PLUGIN_SURFACES,
      scopes: this.files.scopeCatalog(owner),
    };
    }
    if (args.operation === 'describe') {
      const plugin = this.files.plugin(owner, args.pluginId);
      const definitions = this.definitions(owner, plugin);
      return { plugin, actions: Object.entries(plugin.manifest.actions ?? {}).filter(([, a]) => definitions.some(d => d.id === a.service)).map(([id, a]) => ({ ...definitions.find(d => d.id === a.service), id, service: a.service, title: a.title })) };
    }
    if (args.operation === 'layout') return this.files.layout(owner);
    if (args.operation === 'reference') {
      const { plugin } = this.files.instance(owner, args.pluginId, args.instanceId);
      if (!plugin.manifest.views[args.viewId]?.surfaces.includes('chat.message') || typeof args.summary !== 'string' || !args.summary.trim()) throw new Error('plugin_reference_unavailable');
      const reference = { apiVersion: 2, pluginId: plugin.id, instanceId: args.instanceId, viewId: args.viewId, revision: plugin.revision, summary: args.summary };
      return { reference, markdown: `\`\`\`wbw-plugin\n${JSON.stringify(reference)}\n\`\`\`` };
    }
    if (args.operation === 'configure') return this.files.save(owner, PLUGIN_LAYOUT_PATH, args.content, args.expected, args.revision);
    if (args.operation === 'lifecycle') {
      const pkg = this.files.catalog(owner).find(p => p.id === args.pluginId && (!p.error || p.error === 'plugin_uninstalled' || p.error === 'plugin_dependency_unavailable'));
      if (!pkg) throw new Error('plugin_not_found');
      return this.files.lifecycle(owner, pkg.id, pkg.source, args.status, args.expected, args.revision);
    }
    if (args.operation === 'invoke') return this.invokeNamed(owner, args.pluginId, args.instanceId, args.revision, args.actionId, args.args ?? {}, checkActive);
    throw new Error('invalid_plugin_operation');
  }
  async close() { await this.learningCleanup(); this.releaseAccounts(); for (const off of this.effects.splice(0).reverse()) off(); }
}
