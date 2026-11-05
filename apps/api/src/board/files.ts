import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_PATH, BOARD_PLUGINS_PATH, boardPath, boardSlug, parseBoardManifest, parseBoardSchedules, type BoardPlugin } from '@wangke/contracts/board';
import type { SystemDirectory, SystemDocument } from '@wangke/contracts/system';
import type { DatabaseStore } from '../storage/database.js';

// Upgrade only byte-identical shipped files. Edited or removed files stay user-owned.
const DEFAULT_UPGRADES: Record<string, string | string[]> = {
  'README.md': ['28d9509dabb2a031d1a93489c6cb90e714859042de235e0c19bc8da09144c748', '1997ee533fd93d41db4ccd7c158c91dc54503fa45b983a240f7a1a5d65f1c3ed'],
};

/**
 * Everything on the board is a user component. Earlier releases copied four
 * sample packages into every account; an untouched copy (shipped bytes, empty
 * data, no extra instances) is removed once. Any edit or saved data keeps it.
 */
const RETIRED_SAMPLES: Record<string, { code: Record<string, string[]>; data: Record<string, unknown> }> = {
  tasks: { code: { 'manifest.json': ['9266af1624061a317b52b008ec5935a67da8eede3482a8ffb29302f1d6ce2032'], 'index.html': ['d5c070bf58c24ef168f5e8ec51b34edc319e530500c9fc1d1c23255fc618793c', 'de9d14b6a4f05ee120b34f4ae71e18f03e878b05db94462dddf8aa003cfbb999', '39544e7622bb98729a02e259c1026ab6f6e769efa4c7d6b0a2371cbb8473d208'] }, data: {} },
  todo: { code: { 'manifest.json': ['3f45cc0a31599810e801c141a63bcba1749004ff2114b543b61c8338e384af41'], 'index.html': ['913636209b5676b1fcf67a97b74afa9e94e1aac33c099f9ffbc51cf3656d0c5f', '00371c722d1de0f4dac8e2711a19ff4351d1dbd4e0741b5c450fe1134a4fcb74'] }, data: { 'state.json': { items: [] }, 'defaults.json': { items: [] } } },
  pomodoro: { code: { 'manifest.json': ['a9c4a3c082421e5822cef556e692fe7171971ad37d4f0013c4dac11dd041f19d'], 'index.html': ['59acbaf624fc9b3103f1ca5699e49df3366908c073bc1a68a670163618cdd5d3', '69ac11fbd37b45f1740960d432d868df7042d63afa697a257cd7c9735e036470'] }, data: { 'state.json': { durationSeconds: 1500, remainingSeconds: 1500, endsAt: null }, 'defaults.json': { durationSeconds: 1500, remainingSeconds: 1500, endsAt: null } } },
  schedules: { code: { 'manifest.json': ['fdd23e1e4592b4f8960771119cc25e992e72b76f0610d6e8ed6074084c9508db'], 'index.html': ['b36385bf30dcfad688918d3f8108350d931ca2d8d6dfff909cf89c0bce0ed59b', '97203872a4842fbf4f6496adde3e8464efac86e1f6595acf5f4b837917ae472b', '7f2dc74765effd6561072ce861b11616ddeb6ff1589feba1106436530d2f0aa1'] }, data: { 'schedules.json': { jobs: [] } } },
};
// Registered once per account (never written to disk) so a later byte-identical
// package the user installs on purpose is not removed again.
const SAMPLES_RETIRED = `${BOARD_PATH}/samples-retired`;
const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const sameJson = (text: string, expected: unknown) => { try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(expected); } catch { return false; } };

/** Operators may preinstall packages (and tests use fixtures); the product ships none. */
const seedDirectory = () => process.env.BOARD_SEED_DIR ? path.resolve(process.env.BOARD_SEED_DIR) : undefined;

// Bundled upgrades are a process/store bootstrap operation, not a catalog read.
// Cache only a completed, committed bootstrap; live package reads below still
// inspect disk and revalidate manifests, entries and symlink boundaries.
const bootstrapped = new WeakMap<DatabaseStore, Set<string>>();

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
    if (bootstrapped.get(this.store)?.has(owner) && this.store.systemFiles.entry(owner, `${BOARD_PATH}/README.md`)) return;
    const completed = () => {
      if (this.store.db.inTransaction) return;
      let owners = bootstrapped.get(this.store);
      if (!owners) bootstrapped.set(this.store, owners = new Set());
      owners.add(owner);
    };
    const marker = `${BOARD_PATH}/README.md`;
    const source = fileURLToPath(new URL(import.meta.url.endsWith('/runtime/node.mjs') ? '../board-plugins/' : '../../board-plugins/', import.meta.url));
    if (this.store.systemFiles.entry(owner, marker)) {
      if (!this.store.systemFiles.entry(owner, SAMPLES_RETIRED)) this.retireSamples(owner);
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
          if (current !== undefined && (Array.isArray(hash) ? hash : [hash]).includes(sha256(current))) {
            this.store.systemFiles.write(owner, resource, fs.readFileSync(path.join(source, relative), 'utf8'), current);
          }
        } catch { /* A broken/edited default cannot block unrelated plugins. */ }
      }
      completed();
      return;
    }
    const copy = (folder: string, resource: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const target = `${resource}/${entry.name}`;
        if (entry.isDirectory()) copy(path.join(folder, entry.name), target);
        else if (entry.isFile() && this.store.systemFiles.read(owner, target) === undefined) this.store.systemFiles.write(owner, target, fs.readFileSync(path.join(folder, entry.name), 'utf8'), null);
      }
    };
    const seed = seedDirectory();
    this.store.transaction(() => {
      // Only the README and the developer template; the board starts empty.
      copy(source, BOARD_PATH);
      if (seed && fs.existsSync(seed)) copy(seed, BOARD_PLUGINS_PATH);
      this.store.systemFiles.register(owner, SAMPLES_RETIRED);
      this.store.systemFiles.register(owner, marker);
    });
    completed();
  }
  /** One-time cleanup for accounts bootstrapped before the board became user-only. */
  private retireSamples(owner: string) {
    const root = path.join(this.directory(owner), 'plugins');
    const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
    const removable: { id: string; files: string[] }[] = [];
    if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) for (const [id, sample] of Object.entries(RETIRED_SAMPLES)) {
      try {
        const folder = path.join(root, id), stat = fs.lstatSync(folder, { throwIfNoEntry: false });
        if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
        // Extra instances keep their data under the unified plugin data root.
        if (fs.existsSync(path.join(this.store.systemFiles.root, sha256(owner), 'system', 'plugin-data', id))) continue;
        const names = fs.readdirSync(folder);
        const pristine = names.every(name => {
          const resource = `${BOARD_PLUGINS_PATH}/${id}/${name}`;
          const file = fs.lstatSync(path.join(folder, name));
          if (!file.isFile() || file.isSymbolicLink()) return false;
          const content = this.store.systemFiles.read(owner, resource);
          if (content === undefined) return false;
          if (sample.code[name]) return sample.code[name].includes(sha256(content));
          return Object.hasOwn(sample.data, name) && sameJson(content, sample.data[name]);
        });
        if (pristine && names.includes('manifest.json')) removable.push({ id, files: names.map(name => `${BOARD_PLUGINS_PATH}/${id}/${name}`) });
      } catch { /* Anything unreadable is treated as user content. */ }
    }
    this.store.transaction(() => {
      for (const { files } of removable) for (const resource of files) this.store.systemFiles.write(owner, resource, null, this.store.systemFiles.read(owner, resource) ?? null);
      this.store.systemFiles.register(owner, SAMPLES_RETIRED);
    });
    for (const { id, files } of removable) {
      try {
        for (const resource of files) { const intent = this.store.systemFiles.entry(owner, resource)?.intent_id; if (intent) this.store.systemFiles.flush({ owner, intentId: intent }); }
        fs.rmdirSync(path.join(root, id));
      } catch { /* A concurrent edit wins; the intent stays visible in file recovery. */ }
    }
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
