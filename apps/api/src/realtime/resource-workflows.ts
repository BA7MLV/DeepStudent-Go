import crypto from 'node:crypto';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { ResourceCommand } from '@wangke/contracts/resources';
import type { RuntimeJson } from '@wangke/contracts/client-runtime';
import type { ResourceFiles } from '../projects/resources.js';
import { ProjectError } from '../projects/files.js';
import { ProjectFileJournal } from '../projects/file-journal.js';
import type {} from './errors.js';
type ResourceStorage = Pick<ResourceFiles, 'projects'>;

export function resourceScope(resources: ResourceStorage, owner: string) {
  const db = resources.projects.store.db;
  const existing = db.prepare('SELECT scope FROM resource_command_scopes WHERE owner_id=?').get(owner) as { scope: string } | undefined;
  if (existing) return existing.scope;
  db.prepare('INSERT OR IGNORE INTO resource_command_scopes(owner_id,scope) VALUES(?,?)').run(owner, crypto.randomUUID());
  return (db.prepare('SELECT scope FROM resource_command_scopes WHERE owner_id=?').get(owner) as { scope: string }).scope;
}
export function resourceFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ProjectError) return { code: error.code, retryable: error.code === 'project_busy' };
  if (error instanceof RemoteError) return { code: 'code' in error.details ? String(error.details.code) : error.code, retryable: false };
  const code = String((error as NodeJS.ErrnoException)?.code ?? 'resource_failed');
  return { code, retryable: ['EIO', 'EBUSY', 'EMFILE', 'ENFILE', 'SQLITE_BUSY', 'SQLITE_IOERR', 'resource_failed'].includes(code) };
}
export function throwResourceFailure(code: string): never {
  if (code === 'resource_retryable') throw new RemoteError('client/domain', 'Resource operation will retry safely', { code });
  throw new RemoteError('client/domain', 'Resource operation could not be completed', { code });
}

/** Recover only a durable, identity-checked filesystem journal. Legacy pending
 * handlers have no such proof and MUST remain uncertain. This function does not
 * repeat an executor handler or borrow its expired capability. */
export function recoverResourceWorkflow(resources: ResourceStorage, owner: string, operationId: string) {
  const db = resources.projects.store.db;
  const workflow = db.prepare('SELECT request FROM resource_workflows WHERE owner_id=? AND operation_id=?').get(owner, operationId) as { request: string | null } | undefined;
  if (!workflow) return;
  db.transaction(() => {
    const receipt = db.prepare('SELECT status,error FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, operationId) as { status: string; error: string } | undefined;
    if (!receipt) return;
    if (receipt.status === 'completed' || receipt.status === 'failed' && receipt.error !== 'resource_retryable') {
      try {
        new ProjectFileJournal(resources.projects.files, owner, operationId).cleanup();
        db.prepare('DELETE FROM resource_workflows WHERE owner_id=? AND operation_id=?').run(owner, operationId);
      } catch {
        // Cleanup failure must never hide an authoritative terminal outcome.
        db.prepare("UPDATE resource_workflows SET last_error='resource_cleanup_failed',updated_at=? WHERE owner_id=? AND operation_id=?").run(Date.now(), owner, operationId);
      }
      return;
    }
    if (receipt.status !== 'pending') return;
    try {
      const journal = new ProjectFileJournal(resources.projects.files, owner, operationId);
      for (const projectId of journal.projectIds()) resources.projects.assertNoExecution(projectId);
      journal.rollback();
      db.prepare("UPDATE client_commands SET status='failed',error='resource_retryable' WHERE owner_id=? AND operation_id=?").run(owner, operationId);
      db.prepare('UPDATE resource_workflows SET last_error=NULL,updated_at=? WHERE owner_id=? AND operation_id=?').run(Date.now(), owner, operationId);
    } catch (error) {
      // Keep the original file/backup and request intact for support. No generic
      // retry can overwrite an external edit to resolve this condition.
      const code = error instanceof ProjectError && error.code === 'project_busy' ? 'project_busy' : 'resource_rollback_conflict';
      db.prepare('UPDATE resource_workflows SET last_error=?,updated_at=? WHERE owner_id=? AND operation_id=?').run(code, Date.now(), owner, operationId);
    }
  }).immediate();
}

/** Admission survives process death; all domain metadata + the final receipt
 * commit together. Filesystem rollback is itself durable and restartable. */
export function journaledResourceCommand(resources: ResourceStorage, owner: string, request: ResourceCommand, digest: string, binding: string, run: () => RuntimeJson): RuntimeJson {
  const db = resources.projects.store.db;
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO client_commands(owner_id,operation_id,digest,status) VALUES(?,?,?,'pending')").run(owner, request.operationId, digest);
    db.prepare("UPDATE client_commands SET status='pending' WHERE owner_id=? AND operation_id=? AND digest=? AND status='failed' AND error='resource_retryable'").run(owner, request.operationId, digest);
    db.prepare('INSERT OR IGNORE INTO resource_workflows(owner_id,operation_id,request,binding,updated_at) VALUES(?,?,?,?,?)').run(owner, request.operationId, JSON.stringify(request), binding, Date.now());
  }).immediate();
  let journal: ProjectFileJournal | undefined;
  let result: RuntimeJson | undefined, failure: unknown;
  db.transaction(() => {
    // Serialize with other processes using this database, not only JS callers.
    const old = db.prepare('SELECT digest,status,result,error FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId) as { digest: string; status: string; result: string; error: string };
    if (old.digest !== digest) throw new RemoteError('client/conflict', 'Resource operation id reused', {});
    if (old.status === 'completed') { result = JSON.parse(old.result); return; }
    if (old.status === 'failed' && old.error !== 'resource_retryable') throwResourceFailure(old.error);
    journal = new ProjectFileJournal(resources.projects.files, owner, request.operationId);
    // Another process may have left uncertain effects after our preflight.
    // Only the recovery path may undo them; never append a second execution.
    if (journal.hasPendingEffects()) throw new RemoteError('client/uncertain', 'Resource operation is awaiting safe recovery', {});
    db.prepare('UPDATE resource_workflows SET attempts=attempts+1,updated_at=? WHERE owner_id=? AND operation_id=?').run(Date.now(), owner, request.operationId);
    try {
      result = db.transaction(() => resources.projects.files.withJournal(journal!, () => {
        const value = run();
        db.prepare("UPDATE client_commands SET status='completed',result=?,error=NULL WHERE owner_id=? AND operation_id=?").run(JSON.stringify(value), owner, request.operationId);
        db.prepare("INSERT INTO client_changes(owner_id,domain,entity) VALUES(?,'resources',?)").run(owner, request.operationId);
        return value;
      }))();
    } catch (error) {
      const classified = resourceFailure(error);
      try {
        journal!.rollback();
        const code = classified.retryable ? 'resource_retryable' : classified.code;
        db.prepare("UPDATE client_commands SET status='failed',error=? WHERE owner_id=? AND operation_id=?").run(code, owner, request.operationId);
        db.prepare('UPDATE resource_workflows SET last_error=?,updated_at=? WHERE owner_id=? AND operation_id=?').run(classified.code, Date.now(), owner, request.operationId);
        failure = new RemoteError('client/domain', 'Resource operation could not be completed', { code });
      } catch {
        db.prepare("UPDATE resource_workflows SET last_error='resource_rollback_conflict',updated_at=? WHERE owner_id=? AND operation_id=?").run(Date.now(), owner, request.operationId);
        failure = new RemoteError('client/uncertain', 'Resource recovery is preserving an external change', {});
      }
    }
  }).immediate();
  const final = db.prepare('SELECT status,error FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId) as { status: string; error: string };
  if (final.status === 'completed' || final.status === 'failed' && final.error !== 'resource_retryable') {
    try { journal?.cleanup(); db.prepare('DELETE FROM resource_workflows WHERE owner_id=? AND operation_id=?').run(owner, request.operationId); }
    catch { /* A committed receipt is authoritative; cleanup can resume later. */ }
  }
  if (failure) throw failure;
  return result!;
}
