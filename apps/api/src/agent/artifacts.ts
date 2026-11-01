import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { DatabaseStore } from '../storage/database.js';
import { boundedText, budgeted, fitsResult, fittingPrefix, safeEnd } from './result-budget.js';
import type { SandboxOutputSink, SandboxResult } from './sandbox.js';

const ownerQuota = 50 * 1024 * 1024, captureLimit = 16 * 1024 * 1024;
const retentionMs = 7 * 86400000;
const reservations = new WeakMap<DatabaseStore, Map<string, { bytes: number; count: number }>>();
const swept = new WeakMap<DatabaseStore, number>();
type FileOutput = { id: string; decoder: StringDecoder; handle?: fs.promises.FileHandle; bytes: number; chars: number; preview: string; buffer: Buffer[] };

export class BotArtifacts {
  constructor(readonly store: DatabaseStore) {}
  /** Stream directly to API-owned files; never place full shell logs in SQLite.
   * UTF-16LE files preserve the existing artifact_read character-offset API,
   * while StringDecoder handles UTF-8 sequences split across transport frames.
   */
  async captureShell(owner: string, run: string, step: string, operation: (sink: SandboxOutputSink) => Promise<SandboxResult>): Promise<SandboxResult> {
    if (!this.store.db.prepare('SELECT 1 FROM runs r JOIN threads t ON t.id=r.thread_id JOIN run_steps s ON s.run_id=r.id WHERE r.id=? AND t.owner_id=? AND s.id=?').get(run, owner, step)) throw new Error('artifact_run_not_owned');
    let byOwner = reservations.get(this.store);
    if (!byOwner) { byOwner = new Map(); reservations.set(this.store, byOwner); }
    const pending = byOwner.get(owner) ?? { bytes: 0, count: 0 };
    const quota = this.store.db.prepare('SELECT COALESCE(SUM(size_bytes),0) bytes,COUNT(*) count FROM bot_artifacts WHERE owner_id=?').get(owner) as { bytes: number; count: number };
    const allowance = quota.count + pending.count + 2 <= 1000 ? Math.max(0, Math.min(captureLimit, ownerQuota - quota.bytes - pending.bytes)) : 0;
    pending.bytes += allowance; pending.count += 2; byOwner.set(owner, pending);
    const createOutput = (): FileOutput => ({ id: crypto.randomBytes(32).toString('hex'), decoder: new StringDecoder('utf8'), bytes: 0, chars: 0, preview: '', buffer: [] });
    const outputs = { stdout: createOutput(), stderr: createOutput() };
    let capturedBytes = 0, storageError: string | undefined, executionResult: SandboxResult | undefined;
    const filename = (file: FileOutput, partial = false) => path.join(this.store.artifactFilesDir, `${file.id}${partial ? '.part' : '.utf16'}`);
    const write = async (file: FileOutput, text: string) => {
      if (!text) return;
      file.chars += text.length;
      if (file.preview.length < 1500) file.preview += text.slice(0, 1500 - file.preview.length);
      const data = Buffer.from(text, 'utf16le');
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await file.handle!.write(data, offset, data.length - offset);
        if (!bytesWritten) throw new Error('artifact_write_failed');
        offset += bytesWritten;
      }
    };
    const discard = async () => {
      for (const file of Object.values(outputs)) {
        await file.handle?.close().catch(() => {}); file.handle = undefined;
        for (const partial of [true, false]) await fs.promises.unlink(filename(file, partial)).catch(() => {});
      }
    };
    try {
      const result = await operation(async (kind, chunk) => {
        if (storageError || !chunk.length) return;
        if (capturedBytes + chunk.length > allowance) { storageError = 'artifact_quota_exceeded'; return; }
        try {
          const file = outputs[kind];
          capturedBytes += chunk.length; file.bytes += chunk.length;
          if (!file.handle && file.bytes <= 8192) { file.buffer.push(Buffer.from(chunk)); return; }
          if (!file.handle) {
            await fs.promises.mkdir(this.store.artifactFilesDir, { recursive: true, mode: 0o700 });
            if ((await fs.promises.lstat(this.store.artifactFilesDir)).isSymbolicLink()) throw new Error('invalid_artifact_directory');
            file.handle = await fs.promises.open(filename(file, true), 'wx', 0o600);
            for (const buffered of file.buffer) await write(file, file.decoder.write(buffered));
            file.buffer = [];
          }
          await write(file, file.decoder.write(Buffer.from(chunk)));
        } catch { storageError = 'artifact_storage_unavailable'; }
      });
      executionResult = result;
      if (storageError) { await discard(); return { ...result, outputStorageError: storageError }; }
      const artifacts: Record<string, object> = {};
      for (const [kind, file] of Object.entries(outputs)) {
        if (!file.handle) continue;
        await write(file, file.decoder.end());
        await file.handle.sync(); await file.handle.close(); file.handle = undefined;
        // Small, complete results already fit in the returned preview.
        if (!result.output?.[kind === 'stdout' ? 'stdoutTruncated' : 'stderrTruncated']) {
          await fs.promises.unlink(filename(file, true)); continue;
        }
        artifacts[kind] = { artifactId: file.id, sizeBytes: file.bytes, complete: result.output?.complete !== false, read: 'artifact_read(artifactId, offset, length); UTF-16 character offsets; follow nextOffset' };
      }
      if (!Object.keys(artifacts).length) return result;
      this.store.transaction(() => {
        for (const [kind, file] of Object.entries(outputs)) {
          if (!artifacts[kind]) continue;
          // No async gap between publishing the file and its metadata: GC
          // cannot mistake a newly published file for an orphan.
          fs.renameSync(filename(file, true), filename(file));
          this.store.db.prepare('INSERT INTO bot_artifacts(id,owner_id,run_id,step_id,content,size_bytes,created_at) VALUES(?,?,?,?,?,?,?)').run(file.id, owner, run, step, file.preview, file.bytes, new Date().toISOString());
          this.store.db.prepare('INSERT INTO bot_artifact_files(artifact_id,chars,expires_at) VALUES(?,?,?)').run(file.id, file.chars, new Date(Date.now() + retentionMs).toISOString());
        }
      });
      return { ...result, artifacts };
    } catch (error) {
      await discard();
      if (executionResult) return { ...executionResult, outputStorageError: 'artifact_storage_unavailable' };
      throw error;
    } finally {
      pending.bytes -= allowance; pending.count -= 2;
      if (!pending.count) byOwner.delete(owner);
    }
  }

  /** Called by the runtime even when no IM gateway is enabled. Orphan cleanup
   * also handles crashes and ON DELETE CASCADE (thread/account deletion).
   */
  cleanup(time = Date.now()) {
    if (time - (swept.get(this.store) ?? 0) < 60000) return;
    swept.set(this.store, time);
    const expired = this.store.db.prepare('SELECT artifact_id FROM bot_artifact_files WHERE expires_at<=? LIMIT 100').all(new Date(time).toISOString()) as Array<{ artifact_id: string }>;
    for (const row of expired) this.store.db.prepare('DELETE FROM bot_artifacts WHERE id=?').run(row.artifact_id);
    if (!fs.existsSync(this.store.artifactFilesDir)) return;
    for (const name of fs.readdirSync(this.store.artifactFilesDir)) {
      const match = /^([0-9a-f]{64})\.(utf16|part)$/.exec(name);
      if (!match) continue;
      const filename = path.join(this.store.artifactFilesDir, name), stat = fs.lstatSync(filename);
      if (!stat.isFile()) continue;
      if (match[2] === 'part' ? stat.mtimeMs <= time - 3600000 : !this.store.db.prepare('SELECT 1 FROM bot_artifact_files WHERE artifact_id=?').get(match[1])) fs.unlinkSync(filename);
    }
  }
  put(owner: string, run: string, step: string, content: string) {
    const size = Buffer.byteLength(content);
    if (size > 2 * 1024 * 1024) throw new Error('artifact_too_large');
    const id = crypto.createHash('sha256').update(`${owner}\0${run}\0${step}\0${content}`).digest('hex');
    this.store.transaction(() => {
      if (!this.store.db.prepare('SELECT 1 FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(run, owner)) throw new Error('artifact_run_not_owned');
      if (this.store.db.prepare('SELECT 1 FROM bot_artifacts WHERE id=? AND owner_id=?').get(id, owner)) return;
      const quota = this.store.db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes,COUNT(*) AS count FROM bot_artifacts WHERE owner_id=?').get(owner) as { bytes: number; count: number };
      const pending = reservations.get(this.store)?.get(owner);
      if (quota.bytes + size + (pending?.bytes ?? 0) > ownerQuota || quota.count + (pending?.count ?? 0) >= 1000) throw new Error('artifact_quota_exceeded');
      this.store.db.prepare('INSERT INTO bot_artifacts(id,owner_id,run_id,step_id,content,size_bytes,created_at) VALUES(?,?,?,?,?,?,?)').run(id, owner, run, step, content, size, new Date().toISOString());
    });
    return { artifactId: id, sizeBytes: size, preview: content.slice(0, 1500), read: 'artifact_read(artifactId, offset, length); offsets are UTF-16 characters' };
  }
  read(owner: string, id: string, offset = 0, length = 8000, maxTokens = 4096) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 12000) throw new Error('invalid_artifact_range');
    const row = this.store.db.prepare('SELECT content,size_bytes FROM bot_artifacts WHERE id=? AND owner_id=?').get(id, owner) as { content: string; size_bytes: number } | undefined;
    if (!row) throw new Error('artifact_not_found');
    const file = this.store.db.prepare('SELECT chars,expires_at FROM bot_artifact_files WHERE artifact_id=?').get(id) as { chars: number; expires_at: string } | undefined;
    if (file) {
      if (file.expires_at <= new Date().toISOString()) throw new Error('artifact_expired');
      if (offset > file.chars) throw new Error('invalid_result_offset');
      let fd: number;
      try { fd = fs.openSync(path.join(this.store.artifactFilesDir, `${id}.utf16`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch { throw new Error('artifact_storage_unavailable'); }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== file.chars * 2) throw new Error('artifact_storage_unavailable');
        const start = Math.max(0, offset - 1), data = Buffer.alloc(Math.min(file.chars - start, length + 3) * 2);
        let read = 0;
        while (read < data.length) { const n = fs.readSync(fd, data, read, data.length - read, start * 2 + read); if (!n) throw new Error('artifact_storage_unavailable'); read += n; }
        const text = data.toString('utf16le'), local = offset - start;
        if (safeEnd(text, local) !== local) throw new Error('invalid_result_offset');
        const build = (part: string) => ({ artifactId: id, sizeBytes: row.size_bytes, text: part, offset, nextOffset: offset + part.length < file.chars ? offset + part.length : null, totalChars: file.chars, truncated: offset + part.length < file.chars });
        const part = fittingPrefix(text.slice(local, safeEnd(text, local + length)), value => fitsResult(build(value), maxTokens));
        const result = budgeted(build(part), maxTokens);
        if (result.budget.estimatedTokens > maxTokens || !part && offset < file.chars) throw new Error('result_budget_too_small');
        return result;
      } finally { fs.closeSync(fd); }
    }
    return boundedText({ artifactId: id, sizeBytes: row.size_bytes }, row.content, offset, maxTokens, length);
  }
}
