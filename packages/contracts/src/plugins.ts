import { boardSlug, type BoardPlugin } from './board.js';
import { PluginRegistry } from './plugin-registry.js';

export const PLUGINS_PATH = '/system/plugins';
export const PLUGIN_DATA_PATH = '/system/plugin-data';
export const PLUGIN_LAYOUT_PATH = '/system/plugin-layout.json';
export const PLUGIN_HOST_SERVICES: Record<string, number> = { 'learning-data': 1 };
/** One discovery/configuration/action vocabulary for Chat, Bot and HTTP clients. */
export const PLUGINS_TOOL = { type: 'function' as const, function: {
  name: 'plugins',
  description: 'Discover real installed plugins, views, instances and surfaces (list). Use describe with pluginId for available host-validated actions. layout reads the exact layout document; configure replaces it using content, expected and revision (CAS), preserving unrelated instances/placements/navigation. To add a sidebar page, create an app.page placement referencing the exact viewId and instance, then add navigation:{id,placementId,title,order} in the layout navigation array. Removing navigation only removes the shortcut, not data. lifecycle sets pluginId status to enabled, disabled or uninstalled using expected/revision from layout; it retains instances and authoritative learning history, never deletes data or cancels accepted work. Reuse instanceId across surfaces; new IDs are independent. invoke requires pluginId, instanceId, revision, actionId and args from describe. reference takes pluginId/instanceId/viewId/summary and returns exact wbw-plugin Markdown; summaries survive uninstall. Package declarations never grant permissions. Task dispatch is not artifact completion; query durable receipts. Never invent resource or Bot thread IDs.',
  parameters: { type: 'object' as const, additionalProperties: false, properties: {
    operation: { type: 'string', enum: ['list', 'describe', 'layout', 'configure', 'invoke', 'reference', 'lifecycle'] },
    status: { type: 'string', enum: ['enabled', 'disabled', 'uninstalled'] },
    pluginId: { type: 'string', minLength: 1, maxLength: 100 }, instanceId: { type: 'string', minLength: 1, maxLength: 100 },
    actionId: { type: 'string', minLength: 1, maxLength: 100 }, args: { type: 'object' },
    viewId: { type: 'string', minLength: 1, maxLength: 100 }, summary: { type: 'string', minLength: 1, maxLength: 2000 },
    revision: { type: 'integer', minimum: 0 }, content: { type: 'string', maxLength: 100000 }, expected: { type: 'string', maxLength: 100000 },
  }, required: ['operation'] },
} };
export const PLUGIN_SURFACES = ['board.main', 'chat.sidepanel', 'reader.sidepanel', 'app.page', 'chat.message', 'chat.composer.actions', 'reader.selection.actions', 'resource.actions'] as const;
export type PluginSurface = typeof PLUGIN_SURFACES[number];
export const PLUGIN_CAPABILITIES = ['state', 'tasks', 'schedules', 'context', 'resources', 'learning', 'ui'] as const;
export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];
export interface PluginView { entry: string; surfaces: PluginSurface[]; height?: number; title?: string; description?: string }
export interface PluginAction { title: string; service: string; schema: Record<string, unknown> }
export const PLUGIN_ACTION_SURFACES = ['chat.composer.actions', 'reader.selection.actions', 'resource.actions'] as const;
export interface PluginContribution {
  title: string; surfaces: PluginSurface[]; viewId?: string; actionId?: string;
  args?: Record<string, unknown>; contextArgs?: Record<string, 'materialId' | 'selectionText' | 'clientNonce'>;
}
export interface PluginManifest {
  apiVersion: 2; id: string; name: string; version: string; enabled: boolean;
  description?: string; capabilities: PluginCapability[]; views: Record<string, PluginView>;
  actions?: Record<string, PluginAction>; requires?: Record<string, number>; optional?: Record<string, number>;
  services?: Record<string, number>;
  contributions?: Record<string, PluginContribution>;
}
export interface PluginPackage { id: string; path: string; manifest?: PluginManifest; revision?: number; source: 'v1' | 'v2' | 'builtin'; error?: string; installation?: 'enabled' | 'disabled' | 'uninstalled'; provider?: 'native' | 'sandbox'; dependencies?: { required: string[]; optional: string[] } }
export type PluginScope = { kind: 'account' } | { kind: 'material' | 'project'; id: string };
export interface PluginInstance { id: string; pluginId: string; scope: PluginScope; title?: string }
export interface PluginPlacement { id: string; pluginId: string; instanceId: string; viewId: string; surface: PluginSurface; scope: PluginScope; order: number; props?: Record<string, unknown> }
export interface PluginNavigation { id: string; placementId: string; title?: string; order: number }
export interface PluginLayout { apiVersion: 2; instances: PluginInstance[]; placements: PluginPlacement[]; navigation?: PluginNavigation[]; sources?: Record<string, 'v1' | 'v2' | 'builtin'>; disabledBuiltins?: string[]; installations?: Record<string, 'enabled' | 'disabled' | 'uninstalled'> }
export interface PluginScopes {
  projects: { id: string; name: string }[];
  materialProjects: Record<string, string>;
  projectFolders: { folderId: number; projectId: string }[];
  unavailableInstances: string[];
  materials?: { id: string; name: string }[];
}
/** Most-specific layer replaces the same plugin/target at broader layers;
 * multiple placements within the winning layer remain explicitly ordered. */
export function resolvePluginPlacements(layout: PluginLayout, surface: PluginSurface, context: { materialId?: string; projectId?: string }, unavailable: string[] = []) {
  const matches = (s: PluginScope) => s.kind === 'account' || s.kind === 'material' && s.id === context.materialId || s.kind === 'project' && s.id === context.projectId;
  const rank = (s: PluginScope) => s.kind === 'material' ? 2 : s.kind === 'project' ? 1 : 0;
  const candidates = layout.placements.filter(p => {
    const i = layout.instances.find(i => i.id === p.instanceId);
    return p.surface === surface && !unavailable.includes(p.instanceId) && matches(p.scope) && !!i && (matches(i.scope) || !context.materialId && i.scope.kind === 'material' && p.scope.kind === 'account');
  });
  const ranks = new Map<string, number>();
  for (const p of candidates) { const key = `${p.pluginId}:${p.viewId}`; ranks.set(key, Math.max(ranks.get(key) ?? -1, rank(p.scope))); }
  return candidates.filter(p => rank(p.scope) === ranks.get(`${p.pluginId}:${p.viewId}`)).sort((a, b) => a.order - b.order);
}
export interface PluginHostContext {
  surface: PluginSurface; revision: string; locale: string; theme: 'light' | 'dark';
  width: number; mode: 'compact' | 'panel' | 'full' | 'inline'; materialId?: string; projectId?: string;
  conversation?: { kind: 'local-chat' | 'synced-chat' | 'bot'; id: string };
  selection?: { text: string; resourceId: string; offset?: number };
}
export interface PluginTaskOrigin { pluginId: string; instanceId: string; actionId: string; contextRef?: { materialId?: string; projectId?: string } }
export interface PluginMessageReference { apiVersion: 2; pluginId: string; instanceId: string; viewId: string; revision: number; summary: string }
export function parsePluginMessageReference(value: unknown): PluginMessageReference {
  if (!record(value) || value.apiVersion !== 2 || !boardSlug(value.pluginId) || !identity(value.instanceId) || !boardSlug(value.viewId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 2000) throw new Error('invalid_plugin_reference');
  return value as PluginMessageReference;
}
export function pluginPath(value: unknown): boolean {
  return typeof value === 'string' && (value === PLUGIN_LAYOUT_PATH || [PLUGINS_PATH, PLUGIN_DATA_PATH].some(root => value === root || value.startsWith(`${root}/`) && value.slice(root.length + 1).split('/').every(p => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(p) && p !== '..')));
}
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(v);
const fail = (): never => { throw new Error('invalid_plugin_manifest'); };
export function parsePluginManifest(value: unknown, id: string): PluginManifest {
  if (!record(value)) return fail();
  const m = value;
  if (!boardSlug(id) || m.id !== id || m.apiVersion !== 2 || typeof m.enabled !== 'boolean' || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80 || typeof m.version !== 'string' || !m.version || m.version.length > 40 ||
    m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 300) ||
    !Array.isArray(m.capabilities) || m.capabilities.some((c: any) => !PLUGIN_CAPABILITIES.includes(c)) || new Set(m.capabilities).size !== m.capabilities.length ||
    !record(m.views) || !Object.keys(m.views).length || Object.keys(m.views).length > 20) return fail();
  for (const [key, view] of Object.entries(m.views)) {
    if (!boardSlug(key) || !record(view) || typeof view.entry !== 'string' || !/^views\/[a-zA-Z0-9][a-zA-Z0-9_/-]*\.html$/.test(view.entry) || view.entry.split('/').some(p => !p || p === '..') ||
      !Array.isArray(view.surfaces) || !view.surfaces.length || view.surfaces.some((s: any) => !PLUGIN_SURFACES.includes(s)) || new Set(view.surfaces).size !== view.surfaces.length ||
      view.height !== undefined && (!Number.isSafeInteger(view.height) || view.height < 56 || view.height > 2000) ||
      view.title !== undefined && (typeof view.title !== 'string' || !view.title.trim() || view.title.length > 100) ||
      view.description !== undefined && (typeof view.description !== 'string' || view.description.length > 300)) return fail();
  }
  for (const deps of [m.requires, m.optional, m.services]) if (deps !== undefined && (!record(deps) || Object.entries(deps).some(([key, version]) => !boardSlug(key) || !Number.isSafeInteger(version) || Number(version) < 1))) return fail();
  if (m.actions !== undefined && (!record(m.actions) || Object.keys(m.actions).length > 50 || Object.entries(m.actions).some(([key, a]) => !boardSlug(key) || !record(a) || typeof a.title !== 'string' || !a.title || a.title.length > 100 || typeof a.service !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(a.service) || !record(a.schema)))) return fail();
  if (m.contributions !== undefined) {
    if (!record(m.contributions) || Object.keys(m.contributions).length > 50) return fail();
    for (const [id, c] of Object.entries(m.contributions)) {
      if (!boardSlug(id) || m.views[id] || !record(c) || typeof c.title !== 'string' || !c.title || c.title.length > 100 ||
        !Array.isArray(c.surfaces) || !c.surfaces.length || c.surfaces.some((s: any) => !PLUGIN_ACTION_SURFACES.includes(s)) ||
        Number(c.viewId !== undefined) + Number(c.actionId !== undefined) !== 1 ||
        c.viewId !== undefined && (!boardSlug(c.viewId) || !m.views[c.viewId]) ||
        c.actionId !== undefined && (!boardSlug(c.actionId) || !m.actions?.[c.actionId]) ||
        c.args !== undefined && !record(c.args) || c.contextArgs !== undefined && (!record(c.contextArgs) || Object.entries(c.contextArgs).some(([key, value]) => !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key) || !['materialId', 'selectionText', 'clientNonce'].includes(String(value))))) return fail();
    }
  }
  return m as PluginManifest;
}
export function pluginTargets(manifest?: PluginManifest): Record<string, PluginView | PluginContribution> {
  return { ...manifest?.views, ...manifest?.contributions };
}
export function parsePluginLayout(value: unknown): PluginLayout {
  const bad = () => { throw new Error('invalid_plugin_layout'); };
  if (!record(value) || value.apiVersion !== 2 || !Array.isArray(value.instances) || !Array.isArray(value.placements) || value.instances.length > 200 || value.placements.length > 500) return bad();
  if (value.sources !== undefined && (!record(value.sources) || Object.entries(value.sources).some(([id, source]) => !boardSlug(id) || !['v1', 'v2', 'builtin'].includes(source)))) return bad();
  if (value.disabledBuiltins !== undefined && (!Array.isArray(value.disabledBuiltins) || value.disabledBuiltins.length > 100 || value.disabledBuiltins.some((id: unknown) => !boardSlug(id)) || new Set(value.disabledBuiltins).size !== value.disabledBuiltins.length)) return bad();
  if (value.installations !== undefined && (!record(value.installations) || Object.keys(value.installations).length > 300 || Object.entries(value.installations).some(([key, status]) => !/^(v1|v2|builtin):[a-z0-9][a-z0-9_-]{0,63}$/.test(key) || !['enabled', 'disabled', 'uninstalled'].includes(status)))) return bad();
  const scope = (s: any) => record(s) && (s.kind === 'account' || ['material', 'project'].includes(s.kind) && typeof s.id === 'string' && s.id.length > 0 && s.id.length <= 256);
  const ids = new Map<string, string>();
  for (const i of value.instances) {
    if (!record(i) || !identity(i.id) || !boardSlug(i.pluginId) || ids.has(i.id) || !scope(i.scope) || i.title !== undefined && (typeof i.title !== 'string' || i.title.length > 100)) return bad();
    ids.set(i.id, i.pluginId);
  }
  const placements = new Set<string>();
  for (const p of value.placements) {
    if (!record(p) || !identity(p.id) || placements.has(p.id) || ids.get(p.instanceId) !== p.pluginId || !boardSlug(p.viewId) || !PLUGIN_SURFACES.includes(p.surface) || !scope(p.scope) || !Number.isSafeInteger(p.order) || Math.abs(p.order) > 10000 || p.props !== undefined && !record(p.props)) return bad();
    placements.add(p.id);
  }
  if (value.navigation !== undefined) {
    if (!Array.isArray(value.navigation) || value.navigation.length > 100) return bad();
    const entries = new Set<string>();
    for (const n of value.navigation) {
      if (!record(n) || !identity(n.id) || entries.has(n.id) || !value.placements.some((p: PluginPlacement) => p.id === n.placementId && p.surface === 'app.page') ||
        !Number.isSafeInteger(n.order) || Math.abs(n.order) > 10000 || n.title !== undefined && (typeof n.title !== 'string' || !n.title.trim() || n.title.length > 100)) return bad();
      entries.add(n.id);
    }
  }
  return value as PluginLayout;
}
export function adaptBoardPlugin(plugin: BoardPlugin): PluginPackage {
  const m = plugin.manifest;
  return { ...plugin, source: 'v1', manifest: m ? { apiVersion: 2, id: m.id, name: m.name, version: m.version, enabled: m.enabled, description: m.description, capabilities: m.capabilities,
    views: { default: { entry: m.entry, surfaces: ['board.main', 'chat.sidepanel', 'reader.sidepanel', 'app.page', 'chat.message'], height: m.height } } } : undefined };
}

/** Manifest dependencies name packages and require their minimum released major
 * version. This only gates availability, never grants another package's powers. */
export function resolvePluginDependencies(packages: PluginPackage[]): PluginPackage[] {
  packages = packages.map(p => {
    const missing = Object.entries(p.manifest?.services ?? {}).filter(([id, version]) => (PLUGIN_HOST_SERVICES[id] ?? 0) < version).map(([id]) => `host.${id}`);
    return !p.error && p.manifest?.enabled && missing.length ? { ...p, error: 'plugin_service_dependency_unavailable', dependencies: { required: missing, optional: [] } } : p;
  });
  const registry = new PluginRegistry(), disposers: Array<() => void> = [];
  const candidates = packages.filter(p => !p.error && p.manifest?.enabled);
  const major = (p: PluginPackage) => Number(/^([1-9]\d*)(?:\.|$)/.exec(p.manifest!.version)?.[1] ?? 0);
  try {
    for (const p of candidates) disposers.push(registry.register({
      id: p.id, requires: p.manifest!.requires,
      setup: ctx => { const version = major(p); if (Number.isSafeInteger(version) && version > 0) ctx.provide(p.id, { version, value: p }); },
    }));
    return packages.map(p => {
      if (!candidates.includes(p)) return p;
      const unavailable = (deps?: Record<string, number>) => Object.entries(deps ?? {}).filter(([id, v]) => {
        const dependency = registry.get<PluginPackage>(id); return !dependency || major(dependency) < v;
      }).map(([id]) => id);
      const required = unavailable(p.manifest!.requires), optional = unavailable(p.manifest!.optional);
      return { ...p, ...(required.length ? { error: 'plugin_dependency_unavailable' } : {}), ...(required.length || optional.length ? { dependencies: { required, optional } } : {}) };
    });
  } finally { for (const off of disposers.reverse()) off(); }
}
