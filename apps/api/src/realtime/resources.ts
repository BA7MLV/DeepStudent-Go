import crypto from 'node:crypto';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { ResourceCommand } from '@wangke/contracts/resources';
import type { RuntimeJson } from '@wangke/contracts/client-runtime';
import type { ResourceFiles } from '../projects/resources.js';
import { CloudRecords } from '../cloud/records.js';
import { importLibrary } from './library-import.js';
import { replaceCourseSubtitles } from './subtitle-import.js';
import { journaledResourceCommand, recoverResourceWorkflow, resourceScope, throwResourceFailure } from './resource-workflows.js';
import type {} from './errors.js';

/** Durable receipts + write-ahead filesystem recovery, never blind replay of an
 * old handler without an identity-checked journal. */
export function executeResourceCommand(resources: ResourceFiles, owner: string, request: ResourceCommand, binding = ''): RuntimeJson {
  const db = resources.projects.store.db;
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(request.operationId)) throw new RemoteError('gateway/bad-request', 'Invalid resource operation id', {});
  if (request.scope !== undefined && request.scope !== resourceScope(resources, owner)) throw new RemoteError('client/domain', 'Resource database identity changed', { code: 'resource_scope_changed' });
  if (request.delivery && (!['recordMediaDuration', 'recordPlayback', 'recordReadingPosition', 'setReadingView'].includes(request.operation.kind) || !/^[a-zA-Z0-9_-]{16,100}$/.test(request.delivery.stream) || !Number.isSafeInteger(request.delivery.sequence) || request.delivery.sequence < 1)) throw new RemoteError('gateway/bad-request', 'Invalid resource delivery sequence', {});
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const digest = binding + crypto.createHash('sha256').update(canonical({ kind: 'resource', operation: request.operation, ...(request.delivery ? { delivery: request.delivery } : {}) })).digest('hex');
  let old = db.prepare('SELECT digest,status,result,error FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId) as { digest: string; status: string; result: string; error: string } | undefined;
  if (old) {
    if (old.digest !== digest) throw new RemoteError('client/conflict', 'Resource operation id reused', {});
    if (old.status === 'completed') return JSON.parse(old.result);
    if (old.status === 'pending' && request.operation.kind === 'upload' && JSON.parse(old.result ?? 'null')?.operation?.kind === 'upload') return { operationId: request.operationId, upload: true };
    recoverResourceWorkflow(resources, owner, request.operationId);
    old = db.prepare('SELECT digest,status,result,error FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId) as typeof old;
    if (old!.status === 'completed') return JSON.parse(old!.result);
    if (old!.status === 'pending') throw new RemoteError('client/uncertain', 'Resource operation is awaiting safe recovery', {});
    if (old!.error !== 'resource_retryable') throwResourceFailure(old!.error);
  }
  const operation = request.operation;
  if (operation.kind === 'importLibraryBlob') {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(operation.sourceId) || !Number.isSafeInteger(operation.size) || operation.size < 1 || !/^[a-f0-9]{64}$/.test(operation.sha256) || operation.contentType.length > 200) throw new Error('invalid_library_blob');
    db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'pending',?)")
      .run(owner, request.operationId, digest, JSON.stringify({ operation, phase: 'admitted' }));
    return { operationId: request.operationId, upload: true };
  }
  if (operation.kind === 'importLibrary') return importLibrary(resources, owner, request.operationId, digest, operation.library);
  if (operation.kind === 'recordMediaDuration' || operation.kind === 'recordPlayback' || operation.kind === 'recordReadingPosition' || operation.kind === 'setReadingView' || operation.kind === 'setCourseSkills' || operation.kind === 'setCoursePinned' || operation.kind === 'setVideoSource' || operation.kind === 'importSubtitles' || operation.kind === 'pauseTranscription') {
    // Course progress/metadata are SQL domain facts, not filesystem handlers.
    // An old course without a placement is still scoped by authenticated owner.
    return db.transaction(() => {
      const admitted = db.prepare('SELECT digest,status,result,error FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId) as { digest: string; status: string; result: string; error: string } | undefined;
      if (admitted) {
        if (admitted.digest !== digest) throw new RemoteError('client/conflict', 'Resource operation id reused', {});
        if (admitted.status === 'completed') return JSON.parse(admitted.result);
        if (admitted.status === 'pending') throw new RemoteError('client/uncertain', 'Resource operation is awaiting safe recovery', {});
        if (admitted.error !== 'resource_retryable') throwResourceFailure(admitted.error);
      }
      const records = new CloudRecords(resources.projects.store);
      const course = records.get(owner, 'videos', operation.courseId);
      if (!course || course.fileDeleted) throw new RemoteError('client/forbidden', 'Course not available', {});
      const placement = db.prepare('SELECT project_id FROM resource_files WHERE owner_id=? AND course_id=?').get(owner, operation.courseId) as { project_id: string } | undefined;
      if (placement) resources.projects.writable(owner, placement.project_id);
      let changes: Record<string, unknown>;
      if (operation.kind === 'recordMediaDuration') {
        if (!Number.isFinite(operation.duration) || operation.duration <= 0 || operation.duration > 31536000) throw new RemoteError('gateway/bad-request', 'Invalid media duration', {});
        changes = { duration: operation.duration };
      } else if (operation.kind === 'recordPlayback') {
        if (!Number.isFinite(operation.position) || operation.position < 0 || operation.position > 31536000) throw new RemoteError('gateway/bad-request', 'Invalid playback position', {});
        changes = { lastPosition: operation.position, ...(operation.finished === undefined ? {} : { finished: operation.finished ? 1 : 0 }) };
      } else if (operation.kind === 'recordReadingPosition') {
        if (!Number.isSafeInteger(operation.unit) || operation.unit < 0 || operation.unit > 10000000) throw new RemoteError('gateway/bad-request', 'Invalid reading position', {});
        changes = { lastUnit: operation.unit };
      } else if (operation.kind === 'setReadingView') {
        if (operation.view !== 'raw' && operation.view !== 'blocks') throw new RemoteError('gateway/bad-request', 'Invalid reading view', {});
        changes = { htmlView: operation.view };
      } else if (operation.kind === 'setCoursePinned') {
        if (typeof operation.pinned !== 'boolean') throw new RemoteError('gateway/bad-request', 'Invalid course pin', {});
        changes = { pinned: operation.pinned ? 1 : 0 };
      } else if (operation.kind === 'pauseTranscription') {
        changes = { status: 'new', transcriptionPaused: true };
      } else if (operation.kind === 'setVideoSource') {
        const source = operation.source;
        if (!/^BV[a-zA-Z0-9]+$/.test(source.bvid) || [source.aid, source.cid, source.page].some(value => !Number.isSafeInteger(value) || value <= 0)) throw new RemoteError('gateway/bad-request', 'Invalid video source', {});
        changes = { biliSource: source };
      } else if (operation.kind === 'importSubtitles') {
        if (operation.segments.length > 20000 || operation.tracks.length > 100) throw new RemoteError('gateway/bad-request', 'Too many subtitle entries', {});
        for (const cue of [...operation.segments, ...operation.tracks.flatMap(track => track.cues)]) {
          if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end < cue.start || typeof cue.text !== 'string') throw new RemoteError('gateway/bad-request', 'Invalid subtitle cue', {});
        }
        replaceCourseSubtitles(resources.projects.store, owner, operation);
        changes = { status: operation.primary ? 'transcribed' : 'new' };
      } else {
        const ids = [...operation.pin, ...operation.drop];
        if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || !records.get(owner, 'skills', id))) throw new RemoteError('gateway/bad-request', 'Invalid course skills', {});
        changes = { skillOverride: { pin: operation.pin, drop: operation.drop } };
      }
      if (request.delivery) {
        const { stream, sequence } = request.delivery;
        // Playback's optional finished flag is a separate replacement field:
        // a later position-only update must not suppress an earlier completion.
        changes = Object.fromEntries(Object.entries(changes).filter(([field]) => {
          const kind = `${operation.kind}:${field}`;
          const previous = db.prepare('SELECT sequence FROM resource_fact_versions WHERE owner_id=? AND stream=? AND course_id=? AND kind=?').get(owner, stream, operation.courseId, kind) as { sequence: number } | undefined;
          if (previous && previous.sequence >= sequence) return false;
          db.prepare('INSERT INTO resource_fact_versions VALUES(?,?,?,?,?) ON CONFLICT(owner_id,stream,course_id,kind) DO UPDATE SET sequence=excluded.sequence').run(owner, stream, operation.courseId, kind, sequence);
          return true;
        }));
      }
      const result = { ...course, ...changes };
      if (Object.keys(changes).length) records.apply(owner, [{ id: `resource-${request.operationId}`, table: 'videos', key: operation.courseId, before: course, after: result }]);
      db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'completed',?) ON CONFLICT(owner_id,operation_id) DO UPDATE SET status='completed',result=excluded.result,error=NULL")
        .run(owner, request.operationId, digest, JSON.stringify(result));
      return result as RuntimeJson;
    }).immediate();
  }
  if ('projectId' in operation && !['restore', 'deleteTrash'].includes(operation.kind)) resources.projects.get(owner, operation.projectId);
  if (operation.kind === 'move') resources.projects.writable(owner, operation.targetProjectId);
   if (operation.kind === 'createDirectory' || operation.kind === 'saveProjectText' || operation.kind === 'upload') {
    resources.projects.writable(owner, operation.projectId);
    resources.projects.assertNoExecution(operation.projectId);
   }
   if (operation.kind === 'upload') {
     if (!Number.isSafeInteger(operation.size) || operation.size < 0 || !/^[a-f0-9]{64}$/.test(operation.sha256)
       || !operation.path || operation.path.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(operation.path)
       || operation.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid_resource_upload');
      const admission = { operation, phase: 'admitted', resumable: 1, command: request };
      return db.transaction(() => {
        const existing = db.prepare('SELECT digest,status,result,error FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId) as { digest: string; status: string; result: string; error: string } | undefined;
        if (existing) {
          if (existing.digest !== digest) throw new RemoteError('client/conflict', 'Resource operation id reused', {});
          if (existing.status === 'completed') return JSON.parse(existing.result);
          if (existing.status === 'pending') return { operationId: request.operationId, upload: true };
          if (existing.error !== 'resource_retryable') throwResourceFailure(existing.error);
        }
        db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'pending',?) ON CONFLICT(owner_id,operation_id) DO UPDATE SET status='pending',result=excluded.result,error=NULL")
          .run(owner, request.operationId, digest, JSON.stringify(admission));
        return { operationId: request.operationId, upload: true };
      }).immediate();
   }
  return journaledResourceCommand(resources, owner, request, digest, binding, () => {
    // Repeat authorization under the writer lock; preflight happened before
    // admission and another process may have archived/revoked the target.
    if ('projectId' in operation && !['restore', 'deleteTrash'].includes(operation.kind)) resources.projects.get(owner, operation.projectId);
    if (operation.kind === 'saveProjectText' || operation.kind === 'createDirectory') {
      resources.projects.writable(owner, operation.projectId); resources.projects.assertNoExecution(operation.projectId);
    }
    let result: unknown = { ok: true };
    switch (operation.kind) {
      case 'createFolder': {
        resources.migrate(owner);
        const project = resources.projects.create(owner, operation.name);
        result = { ...project, folderId: resources.list(owner, project.id).folderId };
        break;
      }
      case 'createDirectory': resources.projects.writable(owner, operation.projectId); resources.projects.files.mkdir(operation.projectId, operation.path); break;
      case 'renameFolder': result = resources.projects.update(owner, operation.projectId, { name: operation.name }); break;
      case 'folderColor': result = resources.setFolderColor(owner, operation.projectId, operation.path, operation.color); break;
      case 'move': result = { moved: true, ...resources.move(owner, operation.projectId, operation.path, operation.targetProjectId, operation.target, operation.revision) }; break;
      case 'remove': resources.remove(owner, operation.projectId, operation.path, operation.revision); result = { deleted: true }; break;
      case 'trash': result = resources.trash(owner, operation.projectId); break;
      case 'restore': resources.restoreTrash(owner, operation.projectId, operation.expectedDeletedAt); break;
      case 'deleteTrash': resources.deleteTrash(owner, operation.projectId); break;
      case 'saveCourseText': result = resources.saveText(owner, operation.courseId, operation.text, operation.expected); break;
      case 'saveMarkdown': result = resources.saveMarkdown(owner, operation); break;
      case 'organizeCourses': result = resources.organizeCourses(owner, operation.folders); break;
      case 'moveLibrarySelection': result = resources.moveSelection(owner, operation.placements); break;
      case 'saveProjectText': result = resources.projects.files.write(operation.projectId, operation.path, operation.text, operation.expectedRevision); break;
    }
    const value = JSON.parse(JSON.stringify(result ?? null)) as RuntimeJson;
    return value;
  });
}

/** Boot recovery is bounded. Only new account commands with a proven rollback
 * may resume; legacy journals and scoped executor capabilities never replay. */
export function recoverResourceCommands(resources: ResourceFiles) {
  const db = resources.projects.store.db;
  const rows = db.prepare(`SELECT w.owner_id,w.operation_id,w.request,w.binding,w.attempts,c.status,c.error
    FROM resource_workflows w JOIN client_commands c USING(owner_id,operation_id)
    ORDER BY w.updated_at LIMIT 1000`).all() as { owner_id: string; operation_id: string; request: string | null; binding: string; attempts: number; status: string; error: string }[];
  for (const row of rows) {
    try {
      recoverResourceWorkflow(resources, row.owner_id, row.operation_id);
      const receipt = db.prepare('SELECT status,error FROM client_commands WHERE owner_id=? AND operation_id=?').get(row.owner_id, row.operation_id) as { status: string; error: string };
      if (!row.binding && row.request && row.attempts < 6 && receipt.status === 'failed' && receipt.error === 'resource_retryable') {
        executeResourceCommand(resources, row.owner_id, JSON.parse(row.request));
      }
    } catch { /* Preserve the durable evidence; another request may safely retry. */ }
  }
  // No file installation happens until the fully received upload enters its
  // journaled SQL transaction. A process restart therefore releases abandoned
  // receive leases, but never changes an unjournaled legacy transfer.
  for (const row of db.prepare("SELECT owner_id,operation_id,result FROM client_commands WHERE status='pending' AND json_extract(result,'$.phase')='receiving' AND json_extract(result,'$.resumable')=1").all() as { owner_id: string; operation_id: string; result: string }[]) {
    if (db.prepare('SELECT 1 FROM resource_workflows WHERE owner_id=? AND operation_id=?').get(row.owner_id, row.operation_id)) continue;
    db.prepare('UPDATE client_commands SET result=? WHERE owner_id=? AND operation_id=?').run(JSON.stringify({ ...JSON.parse(row.result), phase: 'admitted' }), row.owner_id, row.operation_id);
  }
}
