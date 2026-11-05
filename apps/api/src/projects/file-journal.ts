import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectFiles } from './files.js';

type Location = { id: string; path: string };
type Snapshot = { identity: string; fingerprint: string; revision: string; directory: boolean };
type Entry = { kind: 'replace' | 'remove' | 'move' | 'directory'; source: Location; target?: Location;
  before?: Snapshot; staged?: Snapshot; token: string };
type Manifest = { version: 1; owner: string; operationId: string; entries: Entry[]; aliases: Record<string, string> };

/** Write-ahead undo journal, outside every sandbox mount. SQL metadata and the
 * receipt commit in one transaction. If it rolls back, only OUR unchanged file
 * identities can be restored. Unknown/externally modified effects are retained,
 * never guessed from a filename or matching text. */
export class ProjectFileJournal {
  readonly directory: string;
  private manifest: Manifest;
  constructor(private readonly files: ProjectFiles, owner: string, operationId: string) {
    const root = path.join(path.dirname(files.root), '.resource-journal');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('unsafe_resource_journal');
    this.directory = path.join(root, crypto.createHash('sha256').update(JSON.stringify([owner, operationId])).digest('hex'));
    const existed = fs.existsSync(this.directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_resource_journal');
    const filename = path.join(this.directory, 'manifest.json');
    if (fs.existsSync(filename)) {
      const input = fs.lstatSync(filename);
      if (!input.isFile() || input.nlink !== 1 || input.size > 32 * 1024 * 1024) throw new Error('unsafe_resource_journal');
      this.manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (this.manifest.version !== 1 || this.manifest.owner !== owner || this.manifest.operationId !== operationId) throw new Error('unsafe_resource_journal');
    } else {
      if (existed) throw new Error('resource_journal_manifest_missing');
      this.manifest = { version: 1, owner, operationId, entries: [], aliases: {} };
      this.persist();
    }
  }
  private sync(directory: string) {
    // Linux sandbox paths can be pinned /proc/self/fd/N directory handles.
    // Opening their final '.' keeps O_NOFOLLOW on the actual directory, rather
    // than rejecting the procfs handle itself as a final symlink.
    const pinned = /^\/proc\/self\/fd\/\d+$/.test(directory) ? `${directory}/.` : directory;
    const fd = fs.openSync(pinned, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  private persist() {
    const filename = path.join(this.directory, 'manifest.json'), temporary = `${filename}.next`;
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.manifest)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename); this.sync(this.directory); this.sync(path.dirname(this.directory));
  }
  private snapshot(filename: string): Snapshot | undefined {
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!stat) return;
    const hash = crypto.createHash('sha256');
    let count = 0;
    const visit = (name: string, root: boolean) => {
      if (++count > 100000) throw new Error('resource_journal_tree_too_large');
      const current = fs.lstatSync(name);
      // Rename changes ctime of the root, not its identity or contents. Child
      // ctimes still detect external edits, including a restored mtime.
      hash.update(JSON.stringify([current.dev, current.ino, current.mode,
        current.isDirectory() ? null : current.size, current.isDirectory() ? null : current.mtimeMs, root || current.isDirectory() ? null : current.ctimeMs]));
      // A rename necessarily changes root ctime. Hash root-file bytes instead
      // so restoring mtime cannot disguise an external in-place edit. Streaming
      // keeps even large media bounded in memory; descendants retain ctimes.
      if (root && current.isFile()) {
        const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('resource_journal_unstable');
          const buffer = Buffer.alloc(256 * 1024);
          let position = 0, length: number;
          while ((length = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) { hash.update(buffer.subarray(0, length)); position += length; }
          const after = fs.fstatSync(fd);
          if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('resource_journal_unstable');
        } finally { fs.closeSync(fd); }
      }
      if (current.isSymbolicLink()) hash.update(fs.readlinkSync(name));
      if (current.isDirectory()) for (const child of fs.readdirSync(name).sort()) { hash.update(JSON.stringify(child)); visit(path.join(name, child), false); }
    };
    visit(filename, true);
    return { identity: `${stat.dev}:${stat.ino}`, fingerprint: hash.digest('hex'), revision: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, directory: stat.isDirectory() };
  }
  private matches(filename: string, expected?: Snapshot) {
    const value = this.snapshot(filename);
    return expected === undefined ? value === undefined : value?.identity === expected.identity && value.fingerprint === expected.fingerprint;
  }
  private location<T>(location: Location, run: (filename: string) => T): T { return this.files.journalLocation(location.id, location.path, run); }
  private token(entry: Entry, suffix: string) { return path.join(this.directory, `${entry.token}.${suffix}`); }
  private append(entry: Entry) { this.manifest.entries.push(entry); this.persist(); }
  private alias(location: Location, previous: Snapshot | undefined, filename: string) {
    if (!previous) return;
    const current = this.snapshot(filename);
    if (!current || current.identity !== previous.identity) throw new Error('resource_rollback_conflict');
    const prefix = JSON.stringify([location.id, location.path]);
    for (const key of Object.keys(this.manifest.aliases)) {
      if (key.startsWith(prefix + ':') && this.manifest.aliases[key] === previous.revision) this.manifest.aliases[key] = current.revision;
    }
    this.manifest.aliases[`${prefix}:${previous.revision}`] = current.revision;
  }
  accepts(id: string, filename: string, expected: string | null, actual: string) {
    return expected === actual || expected !== null && this.manifest.aliases[`${JSON.stringify([id, filename])}:${expected}`] === actual;
  }
  projectIds() { return [...new Set(this.manifest.entries.flatMap(entry => [entry.source.id, ...(entry.target ? [entry.target.id] : [])]))]; }
  hasPendingEffects() { return this.manifest.entries.length > 0; }
  replace(location: Location, prepare: (temporary: string) => void) {
    this.location(location, filename => {
      const entry: Entry = { kind: 'replace', source: location, before: this.snapshot(filename), token: crypto.randomUUID() };
      const staged = this.token(entry, 'new');
      prepare(staged);
      const fd = fs.openSync(staged, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      entry.staged = this.snapshot(staged); this.append(entry);
      if (entry.before) fs.linkSync(filename, this.token(entry, 'old'));
      this.sync(this.directory);
      if (entry.before) fs.renameSync(staged, filename);
      else { fs.linkSync(staged, filename); fs.unlinkSync(staged); }
      this.sync(path.dirname(filename)); this.sync(this.directory);
    });
  }
  directoryAt(location: Location) {
    this.location(location, filename => {
      if (fs.existsSync(filename)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      const entry: Entry = { kind: 'directory', source: location, token: crypto.randomUUID() };
      const staged = this.token(entry, 'new');
      fs.mkdirSync(staged, { mode: 0o700 }); this.files.ownJournalFile(staged);
      entry.staged = this.snapshot(staged); this.append(entry);
      fs.renameSync(staged, filename); this.sync(path.dirname(filename)); this.sync(this.directory);
    });
  }
  move(source: Location, target: Location) {
    this.location(source, filename => this.location(target, destination => {
      const entry: Entry = { kind: 'move', source, target, before: this.snapshot(filename), token: crypto.randomUUID() };
      this.append(entry); fs.renameSync(filename, destination);
      this.sync(path.dirname(filename)); this.sync(path.dirname(destination));
    }));
  }
  remove(location: Location) {
    this.location(location, filename => {
      const entry: Entry = { kind: 'remove', source: location, before: this.snapshot(filename), token: crypto.randomUUID() };
      this.append(entry); fs.renameSync(filename, this.token(entry, 'old'));
      this.sync(path.dirname(filename)); this.sync(this.directory);
    });
  }
  /** Idempotent even if recovery itself is interrupted. Persist restored revision
   * aliases BEFORE popping each step; they authorize only the original request. */
  rollback() {
    while (this.manifest.entries.length) {
      const entry = this.manifest.entries.at(-1)!;
      this.location(entry.source, filename => {
        const backup = this.token(entry, 'old');
        if (entry.kind === 'replace') {
          if (this.matches(filename, entry.staged)) {
            if (entry.before) {
              if (!this.matches(backup, entry.before)) throw new Error('resource_rollback_conflict');
              fs.renameSync(backup, filename);
            } else fs.unlinkSync(filename);
          } else if (!this.matches(filename, entry.before)) throw new Error('resource_rollback_conflict');
          // An interrupted installNew can retain its private second link.
          fs.rmSync(this.token(entry, 'new'), { force: true });
          fs.rmSync(backup, { force: true });
          this.alias(entry.source, entry.before, filename);
        } else if (entry.kind === 'directory') {
          if (this.matches(filename, entry.staged)) fs.rmdirSync(filename);
          else if (this.snapshot(filename)) throw new Error('resource_rollback_conflict');
        } else if (entry.kind === 'remove') {
          if (!this.snapshot(filename) && this.matches(backup, entry.before)) fs.renameSync(backup, filename);
          else if (!this.matches(filename, entry.before) || this.snapshot(backup)) throw new Error('resource_rollback_conflict');
          this.alias(entry.source, entry.before, filename);
        } else {
          this.location(entry.target!, destination => {
            if (!this.snapshot(filename) && this.matches(destination, entry.before)) fs.renameSync(destination, filename);
            else if (!this.matches(filename, entry.before) || this.snapshot(destination)) throw new Error('resource_rollback_conflict');
            this.sync(path.dirname(destination));
          });
          this.alias(entry.source, entry.before, filename);
        }
        this.sync(path.dirname(filename)); this.sync(this.directory);
      });
      this.manifest.entries.pop(); this.persist();
    }
  }
  /** Only call after committed success or a proven complete rollback. */
  cleanup() { fs.rmSync(this.directory, { recursive: true, force: true }); this.sync(path.dirname(this.directory)); }
}
