import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_PATH, BOARD_PLUGINS_PATH, boardPath, boardSlug, parseBoardManifest, parseBoardSchedules, type BoardPlugin } from '@wangke/contracts/board';
import type { SystemDirectory, SystemDocument } from '@wangke/contracts/system';
import type { DatabaseStore } from '../storage/database.js';

// Upgrade only byte-identical shipped files. Edited or removed packages stay user-owned.
const DEFAULT_UPGRADES: Record<string, string> = {
  'plugins/tasks/index.html': '39544e7622bb98729a02e259c1026ab6f6e769efa4c7d6b0a2371cbb8473d208',
  'plugins/schedules/index.html': '7f2dc74765effd6561072ce861b11616ddeb6ff1589feba1106436530d2f0aa1',
  'README.md': '28d9509dabb2a031d1a93489c6cb90e714859042de235e0c19bc8da09144c748',
};

/** Directory discovery is the registry; no component or plugin-id switch exists in the host. */
export class BoardFiles {
  constructor(readonly store: DatabaseStore) {}
  private directory(owner: string, resource = BOARD_PATH) {
    if (!boardPath(resource)) throw new Error('invalid_system_path');
    let current = this.store.systemFiles.root;
    for (const part of [null, crypto.createHash('sha256').update(owner).digest('hex'), 'system', ...resource.slice('/system/'.length).split('/')]) {
      if (part) current = path.join(current, part);
      fs.mkdirSync(current, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_system_path');
    }
    return current;
  }
  ensure(owner: string) {
    const marker = `${BOARD_PATH}/README.md`;
    const source = fileURLToPath(new URL(import.meta.url.endsWith('/runtime/node.mjs') ? '../board-plugins/' : '../../board-plugins/', import.meta.url));
    if (this.store.systemFiles.entry(owner, marker)) {
      // Add static instance defaults to still-installed, unedited shipped
      // packages. Never seed from live state, replace user defaults or recreate
      // a missing package. This does not touch any instance/user data.
      const installedRoot = path.join(this.directory(owner), 'plugins');
      if (fs.lstatSync(installedRoot, { throwIfNoEntry: false })?.isDirectory() && !fs.lstatSync(installedRoot).isSymbolicLink()) for (const id of fs.readdirSync(path.join(source, 'plugins')).filter(boardSlug)) {
        const installed = path.join(installedRoot, id), bundled = path.join(source, 'plugins', id);
        const stat = fs.lstatSync(installed, { throwIfNoEntry: false });
        if (!stat?.isDirectory() || stat.isSymbolicLink() || !fs.existsSync(path.join(bundled, 'defaults.json'))) continue;
        const entry = path.join(installed, 'index.html'), entryStat = fs.lstatSync(entry, { throwIfNoEntry: false });
        if (!entryStat?.isFile() || entryStat.isSymbolicLink() || !fs.readFileSync(entry).equals(fs.readFileSync(path.join(bundled, 'index.html')))) continue;
        const target = `${BOARD_PLUGINS_PATH}/${id}/defaults.json`;
        if (!fs.existsSync(path.join(installed, 'defaults.json')) && !this.store.systemFiles.entry(owner, target)) this.store.systemFiles.write(owner, target, fs.readFileSync(path.join(bundled, 'defaults.json'), 'utf8'), null);
      }
      for (const [relative, hash] of Object.entries(DEFAULT_UPGRADES)) {
        try {
          let physical = this.directory(owner);
          const parts = relative.split('/');
          const exists = parts.every((part, i) => {
            physical = path.join(physical, part);
            const stat = fs.lstatSync(physical, { throwIfNoEntry: false });
            return stat && !stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory());
          });
          if (!exists) continue;
          const resource = `${BOARD_PATH}/${relative}`, current = this.store.systemFiles.read(owner, resource);
          if (current !== undefined && crypto.createHash('sha256').update(current).digest('hex') === hash) {
            this.store.systemFiles.write(owner, resource, fs.readFileSync(path.join(source, relative), 'utf8'), current);
          }
        } catch { /* A broken/edited default cannot block unrelated plugins. */ }
      }
      return;
    }
    const copy = (folder: string, resource: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const target = `${resource}/${entry.name}`;
        if (entry.isDirectory()) copy(path.join(folder, entry.name), target);
        else if (entry.isFile() && this.store.systemFiles.read(owner, target) === undefined) this.store.systemFiles.write(owner, target, fs.readFileSync(path.join(folder, entry.name), 'utf8'), null);
      }
    };
    this.store.transaction(() => { copy(source, BOARD_PATH); this.store.systemFiles.register(owner, marker); });
  }
  read(owner: string, resource: string): SystemDocument {
    if (!boardPath(resource) || resource === BOARD_PATH) throw new Error('invalid_system_path');
    this.ensure(owner);
    // SystemFiles can create parents for writes. A stale read/RPC must never
    // recreate an unplugged plugin as an empty, invalid package.
    let parent = this.directory(owner);
    for (const part of resource.slice(BOARD_PATH.length + 1).split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error('unsafe_system_path');
      if (!stat?.isDirectory()) throw new Error('board_file_not_found');
    }
    const content = this.store.systemFiles.read(owner, resource);
    if (content === undefined) throw new Error('board_file_not_found');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    return { path: resource, name: resource.split('/').at(-1)!, content, revision: Number.parseInt(sha256.slice(0, 12), 16), sha256, kind: 'board', updatedAt: null };
  }
  save(owner: string, resource: string, content: string, expected: string, revision: number) {
    if (!boardPath(resource) || resource === BOARD_PATH || typeof content !== 'string' || content.length > 100000 || typeof expected !== 'string' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid_system_document');
    this.ensure(owner);
    let current: SystemDocument | undefined;
    try { current = this.read(owner, resource); } catch (e) { if (!(e instanceof Error) || e.message !== 'board_file_not_found') throw e; }
    if ((current?.content ?? '') !== expected || (current?.revision ?? 0) !== revision) throw new Error('system_revision_conflict');
    if (resource.startsWith(`${BOARD_PLUGINS_PATH}/`) && resource.endsWith('/manifest.json')) parseBoardManifest(JSON.parse(content), resource.split('/').at(-2)!);
    if (resource.endsWith('/schedules.json')) this.validateSchedules(owner, JSON.parse(content));
    if (resource.endsWith('/state.json')) JSON.parse(content);
    this.store.systemFiles.write(owner, resource, content, current?.content ?? null);
    return this.read(owner, resource);
  }
  validateSchedules(owner: string, value: unknown) {
    const data = parseBoardSchedules(value);
    for (const job of data.jobs) if (job.enabled && !this.store.db.prepare("SELECT 1 FROM threads WHERE id=? AND owner_id=? AND mode='bot' AND archived=0").get(job.threadId, owner)) throw new Error('board_thread_not_found');
    return data;
  }
  list(owner: string, resource: string, offset = 0, query = ''): SystemDirectory {
    if (!boardPath(resource) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_system_path');
    this.ensure(owner);
    // Do not turn a read of a missing directory into an installation.
    const root = this.directory(owner);
    let folder = root;
    for (const part of resource.slice(BOARD_PATH.length + 1).split('/').filter(Boolean)) {
      folder = path.join(folder, part);
      const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('board_directory_not_found');
    }
    const entries = fs.readdirSync(folder, { withFileTypes: true }).filter(e => boardPath(`${resource}/${e.name}`) && !e.isSymbolicLink() && (!query || e.name.toLowerCase().includes(query.toLowerCase()))).sort((a, b) => a.name.localeCompare(b.name));
    const files: SystemDirectory['files'] = [], directories: string[] = [];
    for (const entry of entries.slice(offset, offset + 50)) {
      const child = `${resource}/${entry.name}`;
      if (entry.isDirectory()) directories.push(child);
      else if (entry.isFile()) { const { content: _, ...document } = this.read(owner, child); files.push(document); }
    }
    return { files, directories, nextOffset: entries.length > offset + 50 ? offset + 50 : null };
  }
  catalog(owner: string): BoardPlugin[] {
    this.ensure(owner);
    return fs.readdirSync(this.directory(owner, BOARD_PLUGINS_PATH)).filter(boardSlug).sort().slice(0, 100).map<BoardPlugin>(id => {
      try { return this.describe(owner, id); }
      catch (e) { return { id, path: `${BOARD_PLUGINS_PATH}/${id}`, error: e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : 'invalid_board_plugin' }; }
    }).sort((a, b) => (a.manifest?.order ?? 0) - (b.manifest?.order ?? 0) || a.id.localeCompare(b.id));
  }
  private describe(owner: string, id: string) {
    if (!boardSlug(id)) throw new Error('invalid_system_path');
    const resource = `${BOARD_PLUGINS_PATH}/${id}`;
    const document = this.read(owner, `${resource}/manifest.json`);
    const manifest = parseBoardManifest(JSON.parse(document.content), id);
    const entry = this.read(owner, `${resource}/${manifest.entry}`);
    return { id, path: resource, manifest, revision: Number.parseInt(crypto.createHash('sha256').update(document.content).update(entry.content).digest('hex').slice(0, 12), 16) };
  }
  plugin(owner: string, id: string) {
    try {
      const plugin = this.describe(owner, id);
      if (plugin.manifest.enabled) return plugin;
    } catch { /* Removed and invalid plugins revoke the same live RPC endpoint. */ }
    throw new Error('board_plugin_unavailable');
  }
}
