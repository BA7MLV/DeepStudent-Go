import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AGENTS_PATH, MCP_PATH, MEMORY_PATH, SKILLS_PATH, memoryName } from '@wangke/contracts/system';
import { BOARD_PATH, boardPath } from '@wangke/contracts/board';
import { pluginPath } from '@wangke/contracts/plugins';

type Entry = { owner_id: string; path: string; memory_id: string | null; pending: number; content: string | null; expected: string | null; intent_id: string | null };
export type FileIntent = { id: string; owner_id: string; path: string; content: string | null; expected: string | null; observed: string | null;
  status: 'pending' | 'applied' | 'conflict' | 'superseded' | 'discarded'; created_at: string; completed_at: string | null; resolution: string | null; successor_id: string | null; operation_id: string | null };

/** Files are authoritative. SQLite journals pending atomic writes and indexes revisions. */
export class SystemFiles {
  private readonly operation = new AsyncLocalStorage<{ owner: string; id: string }>();
  constructor(readonly root: string, private readonly db: Database.Database) {}

  withOperation<T>(owner: string, id: string, action: () => T): T { return this.operation.run({ owner, id }, action); }

  private filename(owner: string, resource: string) {
    const board = boardPath(resource) && resource !== BOARD_PATH ? resource.slice(BOARD_PATH.length + 1).split('/') : undefined;
    const plugin = pluginPath(resource) ? resource.slice('/system/'.length).split('/') : undefined;
    const name = memoryName(resource);
    const skill = resource.startsWith(`${SKILLS_PATH}/`) ? resource.slice(SKILLS_PATH.length + 1).split('/') : undefined;
    if (skill && (skill.length < 2 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skill[0]) || skill.slice(1).some((part, i) =>
      !part || part === '.' || part === '..' || part.length > 255 || /[\\\u0000-\u001f\u007f]/.test(part) || part.startsWith('.') && !(i === 0 && skill.length === 2 && part === '.wangke-skill.json')))) throw new Error('invalid_system_path');
    if (resource !== AGENTS_PATH && resource !== MCP_PATH && resource !== MEMORY_PATH && !name && !skill && !board && !plugin) throw new Error('invalid_system_path');
    const account = crypto.createHash('sha256').update(owner).digest('hex');
    const directories = [this.root, path.join(this.root, account), path.join(this.root, account, 'system'), path.join(this.root, account, 'system', 'memory')];
    if (skill) {
      let current = path.join(directories[2], 'skills');
      directories.push(current);
      for (const part of skill.slice(0, -1)) { current = path.join(current, part); directories.push(current); }
    }
    if (board) {
      let current = path.join(directories[2], 'board');
      directories.push(current);
      for (const part of board.slice(0, -1)) { current = path.join(current, part); directories.push(current); }
    }
    if (plugin) {
      let current = directories[2];
      for (const part of plugin.slice(0, -1)) { current = path.join(current, part); directories.push(current); }
    }
    for (const directory of directories) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_system_path');
    }
    if (resource === MEMORY_PATH) return directories[3];
    const filename = plugin ? path.join(plugin.length === 1 ? directories[2] : directories.at(-1)!, plugin.at(-1)!) : board ? path.join(directories.at(-1)!, board.at(-1)!) : skill ? path.join(directories.at(-1)!, skill.at(-1)!) : resource === AGENTS_PATH || resource === MCP_PATH ? path.join(directories[2], resource === MCP_PATH ? 'mcp.json' : 'AGENTS.md') : path.join(directories[3], `${name}.md`);
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > (skill ? 2 * 1024 * 1024 : 400000))) throw new Error('unsafe_system_path');
    return filename;
  }

  entry(owner: string, resource: string) {
    return this.db.prepare('SELECT * FROM system_file_entries WHERE owner_id=? AND path=?').get(owner, resource) as Entry | undefined;
  }
  register(owner: string, resource: string, memory: string | null = null) {
    this.filename(owner, resource);
    this.db.prepare('INSERT OR IGNORE INTO system_file_entries(owner_id,path,memory_id) VALUES(?,?,?)').run(owner, resource, memory);
  }
  path(owner: string, memory: string) {
    return (this.db.prepare('SELECT path FROM system_file_entries WHERE owner_id=? AND memory_id=?').get(owner, memory) as { path: string } | undefined)?.path;
  }
  private physical(owner: string, resource: string): string | undefined {
    const filename = this.filename(owner, resource);
    if (!fs.existsSync(filename)) return;
    const text = fs.readFileSync(filename, 'utf8');
    if (text.length > (resource.startsWith(`${SKILLS_PATH}/`) ? 2 * 1024 * 1024 : 100000)) throw new Error('system_file_too_large');
    return text;
  }
  read(owner: string, resource: string): string | undefined {
    const entry = this.entry(owner, resource);
    if (entry?.pending === 1 && this.db.inTransaction) return entry.content ?? undefined;
    if (entry?.pending === 1 && entry.intent_id) this.flush({ owner, intentId: entry.intent_id });
    return this.physical(owner, resource);
  }
  list(owner: string) {
    const filenames = fs.readdirSync(this.filename(owner, MEMORY_PATH));
    if (filenames.length > 10000) throw new Error('system_directory_too_large');
    return filenames.map(name => `${MEMORY_PATH}/${name}`).filter(resource => memoryName(resource)).sort();
  }

  /** Stage inside the same SQL transaction as metadata; rolled-back writes never reach disk. */
  write(owner: string, resource: string, content: string | null, expected?: string | null) {
    const stage = () => {
      const previous = this.read(owner, resource);
      if (expected !== undefined && previous !== (expected ?? undefined)) throw new Error('system_revision_conflict');
      this.register(owner, resource);
      const entry = this.entry(owner, resource)!;
      if (entry.pending === 2) throw Object.assign(new Error('system_file_intent_conflict'), { intentId: entry.intent_id });
      if (previous === (content ?? undefined)) return;
      const id = crypto.randomUUID(), at = new Date().toISOString();
      if (entry.pending === 1) this.db.prepare("UPDATE system_file_intents SET status='superseded',completed_at=?,successor_id=? WHERE id=? AND status='pending'").run(at, id, entry.intent_id);
      const baseline = entry.pending === 1 ? entry.expected : previous ?? null;
      const operation = this.operation.getStore();
      this.db.prepare("INSERT INTO system_file_intents(id,owner_id,path,content,expected,status,created_at,operation_id) VALUES(?,?,?,?,?,'pending',?,?)").run(id, owner, resource, content, baseline, at, operation?.owner === owner ? operation.id : null);
      this.db.prepare('UPDATE system_file_entries SET pending=1,content=?,expected=?,intent_id=? WHERE owner_id=? AND path=?').run(content, baseline, id, owner, resource);
    };
    if (this.db.inTransaction) stage();
    else {
      this.db.transaction(stage)();
      const intentId = this.entry(owner, resource)?.intent_id;
      if (intentId) this.flush({ owner, intentId });
    }
    return content;
  }

  receipt(owner: string, id: string) {
    return this.db.prepare('SELECT * FROM system_file_intents WHERE owner_id=? AND id=?').get(owner, id) as FileIntent | undefined;
  }
  /** Query recovery may finish only a durable conditional intent, never its handler. */
  reconcile(owner: string, id: string) {
    const intent = this.receipt(owner, id);
    if (intent?.status === 'pending') {
      try { this.flush({ owner, intentId: id }); } catch { /* Keep pending/conflict visible with all original bytes. */ }
    }
    return this.receipt(owner, id);
  }
  current(owner: string, resource: string) { return this.physical(owner, resource) ?? null; }

  conflicts(owner: string) {
    return this.db.prepare("SELECT * FROM system_file_intents WHERE owner_id=? AND status='conflict' ORDER BY created_at,id").all(owner) as FileIntent[];
  }

  operationOutcome(owner: string, operation: string): 'applied' | 'pending' | 'conflict' | 'discarded' {
    const intents = this.db.prepare('SELECT * FROM system_file_intents WHERE owner_id=? AND operation_id=?').all(owner, operation) as FileIntent[];
    let pending = false;
    for (let intent of intents) {
      const visited = new Set<string>();
      while (intent.status === 'superseded' && intent.successor_id && !visited.has(intent.id)) {
        visited.add(intent.id);
        const successor = this.receipt(owner, intent.successor_id);
        if (!successor) break;
        intent = successor;
      }
      if (intent.status === 'conflict' || intent.status === 'superseded') return 'conflict';
      if (intent.status === 'discarded') return 'discarded';
      if (intent.status === 'pending') pending = true;
    }
    return pending ? 'pending' : 'applied';
  }

  /** Explicit CAS resolution only. Never replay a conflicted intent on startup. */
  resolve(owner: string, id: string, observed: string | null, action: 'retry' | 'discard') {
    let replacement: string | undefined;
    const resolution = JSON.stringify({ observed, action });
    this.db.transaction(() => {
      const intent = this.receipt(owner, id);
      if (intent?.resolution) {
        if (intent.resolution !== resolution) throw new Error('system_file_resolution_conflict');
        replacement = intent.successor_id ?? undefined;
        return;
      }
      if (!intent || intent.status !== 'conflict' || this.entry(owner, intent.path)?.intent_id !== id) throw new Error('system_file_intent_not_conflicted');
      if ((this.physical(owner, intent.path) ?? null) !== observed) throw new Error('system_revision_conflict');
      this.db.prepare("UPDATE system_file_intents SET status=?,completed_at=? WHERE id=?").run(action === 'retry' ? 'superseded' : 'discarded', new Date().toISOString(), id);
      this.db.prepare('UPDATE system_file_entries SET pending=0,content=NULL,expected=NULL,intent_id=NULL WHERE owner_id=? AND path=?').run(owner, intent.path);
      if (action === 'retry') {
        this.write(owner, intent.path, intent.content, observed); replacement = this.entry(owner, intent.path)?.intent_id ?? undefined;
        if (!replacement) {
          replacement = crypto.randomUUID();
          const at = new Date().toISOString();
          this.db.prepare("INSERT INTO system_file_intents(id,owner_id,path,content,expected,observed,status,created_at,completed_at) VALUES(?,?,?,?,?,?,'applied',?,?)").run(replacement, owner, intent.path, intent.content, observed, observed, at, at);
        }
      }
      this.db.prepare('UPDATE system_file_intents SET resolution=?,successor_id=? WHERE id=?').run(resolution, replacement ?? null, id);
    })();
    if (replacement) this.flush({ owner, intentId: replacement });
    return replacement ? this.receipt(owner, replacement) : this.receipt(owner, id);
  }

  private conflicted(entry: Entry, observed: string | null) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE system_file_intents SET status='conflict',observed=?,completed_at=? WHERE id=?").run(observed, new Date().toISOString(), entry.intent_id);
      this.db.prepare('UPDATE system_file_entries SET pending=2 WHERE owner_id=? AND path=? AND intent_id=?').run(entry.owner_id, entry.path, entry.intent_id);
    })();
    return Object.assign(new Error('system_file_changed'), { intentId: entry.intent_id });
  }

  /** Crash replay is conditional: never overwrite a newer external edit. */
  flush(operation?: { owner: string; id: string } | { owner: string; intentId: string }) {
    if (this.db.inTransaction) return;
    const pending = (operation
      ? this.db.prepare(`SELECT e.* FROM system_file_entries e JOIN system_file_intents i ON i.id=e.intent_id WHERE e.pending=1 AND i.owner_id=? AND ${'intentId' in operation ? 'i.id' : 'i.operation_id'}=?`).all(operation.owner, 'intentId' in operation ? operation.intentId : operation.id)
      : this.db.prepare('SELECT * FROM system_file_entries WHERE pending=1').all()) as Entry[];
    for (const entry of pending) {
      const current = this.physical(entry.owner_id, entry.path) ?? null;
      const filename = this.filename(entry.owner_id, entry.path);
      if (current !== entry.content) {
        if (current !== entry.expected) {
          throw this.conflicted(entry, current);
        }
        if (entry.content === null) fs.rmSync(filename, { force: true });
        else {
          const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
          try {
            const mode = fs.statSync(filename, { throwIfNoEntry: false })?.mode ?? 0o600;
            const fd = fs.openSync(temporary, 'wx', mode & 0o777);
            try { fs.writeFileSync(fd, entry.content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            const observed = this.physical(entry.owner_id, entry.path) ?? null;
            if (observed !== current) throw this.conflicted(entry, observed);
            fs.renameSync(temporary, filename);
          } finally { fs.rmSync(temporary, { force: true }); }
        }
      }
      // Persist the rename/unlink (including replay) before completing its intent.
      const directory = fs.openSync(path.dirname(filename), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.db.transaction(() => {
        this.db.prepare("UPDATE system_file_intents SET status='applied',observed=?,completed_at=? WHERE id=?").run(entry.content, new Date().toISOString(), entry.intent_id);
        this.db.prepare('UPDATE system_file_entries SET pending=0,content=NULL,expected=NULL WHERE owner_id=? AND path=? AND intent_id=?').run(entry.owner_id, entry.path, entry.intent_id);
      })();
    }
  }
}
