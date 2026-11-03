import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { boardSlug } from '@wangke/contracts/board';
import { PLUGINS_PATH, PLUGIN_DATA_PATH, PLUGIN_LAYOUT_PATH, pluginPath, parsePluginManifest, parsePluginLayout, adaptBoardPlugin, resolvePluginDependencies, type PluginLayout, type PluginPackage, type PluginScope } from '@wangke/contracts/plugins';
import type { SystemDirectory, SystemDocument } from '@wangke/contracts/system';
import { BoardFiles } from '../board/files.js';
import type { DatabaseStore } from '../storage/database.js';
import { INSTALLED_LEARNING_PLUGINS, learningTaskProvider } from '@wangke/contracts/learning-plugins';
import { pluginTargets } from '@wangke/contracts/plugins';
import { ProjectRepository } from '../projects/repository.js';
import { CloudRecords } from '../cloud/records.js';

/** Reuses the SystemFiles transaction journal. All authority comes from the authenticated owner. */
export class PluginFiles {
  readonly board: BoardFiles;
  readonly projects: ProjectRepository;
  nativeAvailable?: (id: string) => boolean;
  nativePackages?: () => PluginPackage[];
  constructor(readonly store: DatabaseStore, projects?: ProjectRepository, filesDir = process.env.FILES_DIR ?? path.resolve(process.env.DATA_DIR ?? 'data', 'files')) {
    this.board = new BoardFiles(store);
    this.projects = projects ?? new ProjectRepository(store, path.join(filesDir, 'projects'));
  }
  private physical(owner: string, resource: string, createRoot = false) {
    if (!pluginPath(resource)) throw new Error('invalid_system_path');
    const root = path.join(this.store.systemFiles.root, crypto.createHash('sha256').update(owner).digest('hex'), 'system');
    let current = this.store.systemFiles.root;
    for (const part of [crypto.createHash('sha256').update(owner).digest('hex'), 'system', ...resource.slice('/system/'.length).split('/')]) {
      current = path.join(current, part);
      if (createRoot && (current === root || !current.startsWith(`${root}/`) || resource === PLUGINS_PATH || resource === PLUGIN_DATA_PATH)) fs.mkdirSync(current, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error('unsafe_system_path');
      if (!stat) return undefined;
    }
    return current;
  }
  read(owner: string, resource: string): SystemDocument {
    const physical = this.physical(owner, resource);
    if (!physical || !fs.statSync(physical).isFile()) throw new Error('plugin_file_not_found');
    const content = this.store.systemFiles.read(owner, resource);
    if (content === undefined) throw new Error('plugin_file_not_found');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    return { path: resource, name: resource.split('/').at(-1)!, kind: 'board', content, sha256, revision: Number.parseInt(sha256.slice(0, 12), 16), updatedAt: null };
  }
  save(owner: string, resource: string, content: string, expected: string, revision: number) {
    if (!pluginPath(resource) || [PLUGINS_PATH, PLUGIN_DATA_PATH].includes(resource) || typeof content !== 'string' || content.length > 100000 || typeof expected !== 'string' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid_system_document');
    let before: SystemDocument | undefined;
    try { before = this.read(owner, resource); } catch (e) { if (!(e instanceof Error) || e.message !== 'plugin_file_not_found') throw e; }
    if ((before?.content ?? '') !== expected || (before?.revision ?? 0) !== revision) throw new Error('system_revision_conflict');
    if (/^\/system\/plugins\/[^/]+\/manifest.json$/.test(resource)) parsePluginManifest(JSON.parse(content), resource.split('/')[3]);
    if (resource === PLUGIN_LAYOUT_PATH) this.validateLayout(owner, parsePluginLayout(JSON.parse(content)));
    if (resource.endsWith('/schedules.json')) this.board.validateSchedules(owner, JSON.parse(content));
    else if (resource.endsWith('.json')) JSON.parse(content);
    this.store.systemFiles.write(owner, resource, content, before?.content ?? null);
    return this.read(owner, resource);
  }
  list(owner: string, resource: string, offset = 0, query = ''): SystemDirectory {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_offset');
    const folder = this.physical(owner, resource, resource === PLUGINS_PATH || resource === PLUGIN_DATA_PATH);
    if (!folder || !fs.statSync(folder).isDirectory()) throw new Error('plugin_directory_not_found');
    const entries = fs.readdirSync(folder, { withFileTypes: true }).filter(e => !e.isSymbolicLink() && pluginPath(`${resource}/${e.name}`) && (!query || e.name.toLowerCase().includes(query.toLowerCase()))).sort((a, b) => a.name.localeCompare(b.name));
    const files: SystemDirectory['files'] = [], directories: string[] = [];
    for (const e of entries.slice(offset, offset + 50)) {
      const child = `${resource}/${e.name}`;
      if (e.isDirectory()) directories.push(child);
      else if (e.isFile()) { const { content: _, ...doc } = this.read(owner, child); files.push(doc); }
    }
    return { files, directories, nextOffset: entries.length > offset + 50 ? offset + 50 : null };
  }
  catalog(owner: string, sources?: PluginLayout['sources'], proposed?: PluginLayout): PluginPackage[] {
    let savedLayout: PluginLayout | undefined;
    try { savedLayout = parsePluginLayout(JSON.parse(this.read(owner, PLUGIN_LAYOUT_PATH).content)); } catch { /* No layout yet. */ }
    savedLayout = proposed ?? savedLayout;
    // Publish only packages with a working host provider; metadata is not an installed feature.
    const packages = [...this.board.catalog(owner).map(adaptBoardPlugin), ...(this.nativePackages?.() ?? INSTALLED_LEARNING_PLUGINS)];
    const folder = this.physical(owner, PLUGINS_PATH, true)!;
    for (const id of fs.readdirSync(folder).filter(boardSlug).sort().slice(0, 100)) {
      const resource = `${PLUGINS_PATH}/${id}`;
      try {
        const doc = this.read(owner, `${resource}/manifest.json`), manifest = parsePluginManifest(JSON.parse(doc.content), id);
        const hash = crypto.createHash('sha256').update(doc.content);
        for (const view of Object.values(manifest.views)) hash.update(this.read(owner, `${resource}/${view.entry}`).content);
        packages.push({ id, path: resource, source: 'v2', manifest, revision: Number.parseInt(hash.digest('hex').slice(0, 12), 16) });
      } catch (e) { packages.push({ id, path: resource, source: 'v2', error: e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : 'invalid_plugin_package' }); }
    }
    const counts = new Map<string, number>();
    for (const p of packages) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    sources ??= savedLayout?.sources;
    return resolvePluginDependencies(packages.map(original => {
      const installation = savedLayout?.installations?.[`${original.source}:${original.id}`] ?? (original.source === 'builtin' && savedLayout?.disabledBuiltins?.includes(original.id) || original.manifest?.enabled === false ? 'disabled' : 'enabled');
      const p: PluginPackage = { ...original, installation, provider: original.source === 'builtin' ? 'native' : 'sandbox', manifest: original.manifest ? { ...original.manifest, enabled: installation === 'enabled' } : undefined,
        ...(installation === 'uninstalled' ? { error: 'plugin_uninstalled' } : original.source === 'builtin' && this.nativeAvailable && !this.nativeAvailable(original.id) ? { error: 'plugin_provider_unavailable' } : {}) };
      return counts.get(p.id)! > 1 && sources?.[p.id] !== p.source ? { ...p, error: sources?.[p.id] ? 'plugin_source_not_selected' : 'plugin_source_conflict' } : p;
    }));
  }
  admitTask(owner: string, kind: string, input: Record<string, unknown>) {
    const provider = learningTaskProvider(kind, input);
    if (provider) this.plugin(owner, provider);
    return { ...input, _pluginProviders: this.catalog(owner).filter(p => !p.error && p.manifest?.enabled && p.source === 'builtin').map(p => p.id) };
  }
  lifecycle(owner: string, id: string, source: PluginPackage['source'], status: NonNullable<PluginPackage['installation']>, expected: string, revision: number) {
    if (!['enabled', 'disabled', 'uninstalled'].includes(status)) throw new Error('invalid_plugin_installation');
    if (!this.catalog(owner).some(p => p.id === id && p.source === source && p.manifest)) throw new Error('plugin_not_found');
    const current = this.layout(owner), layout = parsePluginLayout(JSON.parse(current.content));
    layout.installations = { ...layout.installations, [`${source}:${id}`]: status };
    // Keep code, instances, schedules and authoritative domain data for explicit recovery.
    return this.save(owner, current.path, JSON.stringify(layout, null, 2) + '\n', expected, revision);
  }
  plugin(owner: string, id: string) {
    const p = this.catalog(owner).find(p => p.id === id && !p.error);
    if (!p?.manifest?.enabled || p.error) throw new Error('plugin_unavailable');
    return p as PluginPackage & { manifest: NonNullable<PluginPackage['manifest']> };
  }
  layout(owner: string) {
    try {
      const current = this.read(owner, PLUGIN_LAYOUT_PATH), data = parsePluginLayout(JSON.parse(current.content));
      let changed = false;
      // Import newly discovered v1 packages once, never restore an explicitly hidden placement.
      for (const p of this.catalog(owner).filter(p => p.source === 'v1' && !p.error)) if (!data.instances.some(i => i.id === `legacy-${p.id}`)) {
        data.instances.push({ id: `legacy-${p.id}`, pluginId: p.id, scope: { kind: 'account' } });
        data.placements.push({ id: `legacy-${p.id}`, pluginId: p.id, instanceId: `legacy-${p.id}`, viewId: 'default', surface: 'board.main', scope: { kind: 'account' }, order: data.placements.length });
        changed = true;
      }
      return changed ? this.save(owner, current.path, JSON.stringify(data, null, 2) + '\n', current.content, current.revision) : current;
    } catch (e) {
      if (!(e instanceof Error) || e.message !== 'plugin_file_not_found') throw e;
      const legacy = this.catalog(owner).filter(p => p.source === 'v1' && !p.error);
      const data: PluginLayout = { apiVersion: 2, instances: legacy.map(p => ({ id: `legacy-${p.id}`, pluginId: p.id, scope: { kind: 'account' } })), placements: legacy.map((p, index) => ({ id: `legacy-${p.id}`, pluginId: p.id, instanceId: `legacy-${p.id}`, viewId: 'default', surface: 'board.main', scope: { kind: 'account' }, order: index })) };
      return this.save(owner, PLUGIN_LAYOUT_PATH, JSON.stringify(data, null, 2) + '\n', '', 0);
    }
  }
  materialProject(owner: string, id: string) {
    const course = new CloudRecords(this.store).get(owner, 'videos', id);
    if (!course || course.fileDeleted) throw new Error('plugin_material_not_found');
    const mapped = this.store.db.prepare('SELECT project_id,path FROM resource_files WHERE owner_id=? AND course_id=?').get(owner, id) as { project_id: string; path: string } | undefined;
    if (!mapped) return undefined; // Legacy local/blob resources have no fabricated project.
    this.projects.writable(owner, mapped.project_id);
    const opened = this.projects.files.open(mapped.project_id, mapped.path);
    fs.closeSync(opened.fd);
    return mapped.project_id;
  }
  validateScope(owner: string, scope: PluginScope) {
    if (scope.kind === 'material') this.materialProject(owner, scope.id);
    if (scope.kind === 'project') this.projects.writable(owner, scope.id);
  }
  scopeCatalog(owner: string) {
    const projects = this.projects.list(owner).filter(p => !p.archived).map(p => ({ id: p.id, name: p.name }));
    const projectIds = new Set(projects.map(p => p.id)), materialProjects: Record<string, string> = {};
    for (const row of this.store.db.prepare('SELECT course_id FROM resource_files WHERE owner_id=?').all(owner) as { course_id: string }[]) {
      try { const id = this.materialProject(owner, row.course_id); if (id) materialProjects[row.course_id] = id; } catch { /* Revoked, trashed, deleted or archived: never a live host context. */ }
    }
    const projectFolders = (this.store.db.prepare('SELECT folder_id AS folderId,project_id AS projectId FROM resource_folders WHERE owner_id=?').all(owner) as { folderId: number; projectId: string }[]).filter(p => projectIds.has(p.projectId));
    let instances: PluginLayout['instances'] = [];
    try { instances = parsePluginLayout(JSON.parse(this.read(owner, PLUGIN_LAYOUT_PATH).content)).instances; } catch { /* First visit. */ }
    const unavailableInstances = instances.filter(i => { try { this.validateScope(owner, i.scope); return false; } catch { return true; } }).map(i => i.id);
    const records = new CloudRecords(this.store);
    const materialIds = new Set((this.store.db.prepare("SELECT record_key FROM cloud_records WHERE owner_id=? AND table_name='videos' AND value IS NOT NULL").all(owner) as { record_key: string }[]).map(row => String(JSON.parse(row.record_key))));
    const materials = [...materialIds].flatMap(id => { try { this.materialProject(owner, id); const row = records.get(owner, 'videos', id); return row ? [{ id, name: String(row.name ?? '资料') }] : []; } catch { return []; } });
    return { projects, materialProjects, projectFolders, unavailableInstances, materials };
  }
  private validateLayout(owner: string, layout: PluginLayout) {
    const packages = this.catalog(owner, layout.sources, layout);
    let previous: PluginLayout | undefined;
    try { previous = parsePluginLayout(JSON.parse(this.read(owner, PLUGIN_LAYOUT_PATH).content)); } catch { /* First layout. */ }
    for (const i of layout.instances) {
      const existing = previous?.instances.find(row => row.id === i.id);
      try { this.validateScope(owner, i.scope); } catch (error) { if (JSON.stringify(existing) !== JSON.stringify(i)) throw error; }
      if (existing && (existing.pluginId !== i.pluginId || JSON.stringify(existing.scope) !== JSON.stringify(i.scope))) throw new Error('plugin_instance_binding_conflict');
      if (!packages.some(p => p.id === i.pluginId && !p.error && p.manifest?.enabled) && JSON.stringify(existing) !== JSON.stringify(i)) throw new Error('plugin_unavailable');
    }
    for (const p of layout.placements) {
      const unchanged = previous?.placements.some(row => JSON.stringify(row) === JSON.stringify(p));
      try {
        this.validateScope(owner, p.scope);
        const instance = layout.instances.find(i => i.id === p.instanceId)!;
        this.validateScope(owner, instance.scope);
        if (instance.scope.kind === 'project' && !(p.scope.kind === 'project' && p.scope.id === instance.scope.id || p.scope.kind === 'material' && this.materialProject(owner, p.scope.id) === instance.scope.id)) throw new Error('plugin_project_placement_denied');
        if (instance.scope.kind === 'material' && p.scope.kind === 'project' && this.materialProject(owner, instance.scope.id) !== p.scope.id) throw new Error('plugin_material_denied');
        if (instance.scope.kind === 'material' && p.scope.kind === 'material' && instance.scope.id !== p.scope.id) throw new Error('plugin_material_denied');
      } catch (error) { if (!unchanged) throw error; }
      const plugin = packages.find(pkg => pkg.id === p.pluginId && !pkg.error);
      if (!plugin?.manifest?.enabled && !unchanged) throw new Error('plugin_unavailable');
      if (!pluginTargets(plugin?.manifest)[p.viewId]?.surfaces.includes(p.surface) && !previous?.placements.some(row => JSON.stringify(row) === JSON.stringify(p))) throw new Error('plugin_surface_unavailable');
    }
    for (const entry of layout.navigation ?? []) {
      if (previous?.navigation?.some(row => JSON.stringify(row) === JSON.stringify(entry))) continue;
      const placement = layout.placements.find(p => p.id === entry.placementId)!;
      const instance = layout.instances.find(i => i.id === placement.instanceId)!;
      this.validateScope(owner, placement.scope);
      this.validateScope(owner, instance.scope);
      const plugin = packages.find(p => p.id === instance.pluginId && !p.error && p.manifest?.enabled);
      if (!plugin?.manifest?.views[placement.viewId]?.surfaces.includes('app.page')) throw new Error('plugin_surface_unavailable');
    }
  }
  instance(owner: string, pluginId: string, instanceId: string) {
    const plugin = this.plugin(owner, pluginId);
    const layout = parsePluginLayout(JSON.parse(this.layout(owner).content));
    const instance = layout.instances.find(i => i.id === instanceId && i.pluginId === pluginId);
    if (!instance) throw new Error('plugin_instance_not_found');
    this.validateScope(owner, instance.scope);
    return { plugin, instance };
  }
  statePath(owner: string, pluginId: string, instanceId: string, kind: 'state' | 'schedules') {
    const { plugin } = this.instance(owner, pluginId, instanceId);
    if (!plugin.manifest.capabilities.includes(kind)) throw new Error('plugin_capability_denied');
    return plugin.source === 'v1' && instanceId === `legacy-${pluginId}` ? `${plugin.path}/${kind}.json` : `${PLUGIN_DATA_PATH}/${pluginId}/instances/${instanceId}/${kind}.json`;
  }
  readState(owner: string, pluginId: string, instanceId: string, kind: 'state' | 'schedules') {
    const resource = this.statePath(owner, pluginId, instanceId, kind);
    if (resource.startsWith('/system/board/')) return this.board.read(owner, resource);
    try { return this.read(owner, resource); } catch (e) {
      if (!(e instanceof Error) || e.message !== 'plugin_file_not_found') throw e;
      const { plugin } = this.instance(owner, pluginId, instanceId);
      let content = kind === 'schedules' ? '{"jobs":[]}\n' : '{}\n';
      if (kind === 'state' && plugin.source !== 'builtin') {
        // v1 state.json is live legacy user content, never a seed for a new
        // independent instance. Packages may declare a separate defaults file.
        try { content = plugin.source === 'v1' ? this.board.read(owner, `${plugin.path}/defaults.json`).content : this.read(owner, `${plugin.path}/defaults.json`).content; } catch { /* Optional defaults. */ }
      }
      return this.save(owner, resource, content, '', 0);
    }
  }
  writeState(owner: string, pluginId: string, instanceId: string, kind: 'state' | 'schedules', data: unknown, expected: string, revision: number) {
    const resource = this.statePath(owner, pluginId, instanceId, kind), content = JSON.stringify(data, null, 2) + '\n';
    return resource.startsWith('/system/board/') ? this.board.save(owner, resource, content, expected, revision) : this.save(owner, resource, content, expected, revision);
  }
}
