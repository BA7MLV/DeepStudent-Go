import crypto from 'node:crypto';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { ResourceCommand } from '@wangke/contracts/resources';
import type { RuntimeJson } from '@wangke/contracts/client-runtime';
import type { ResourceFiles } from '../projects/resources.js';
import { CloudRecords } from '../cloud/records.js';
import { importLibrary } from './library-import.js';
import type {} from './errors.js';

/** Filesystem effects are not SQLite atomic. Persist admission before dispatch,
 * then never replay an uncertain outcome, even if the process died mid-handler. */
export function executeResourceCommand(resources: ResourceFiles, owner: string, request: ResourceCommand, binding = ''): RuntimeJson {
  const db = resources.projects.store.db;
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(request.operationId)) throw new RemoteError('gateway/bad-request', 'Invalid resource operation id', {});
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const digest = binding + crypto.createHash('sha256').update(canonical({ kind: 'resource', operation: request.operation })).digest('hex');
  const old = db.prepare('SELECT digest,status,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId) as { digest: string; status: string; result: string } | undefined;
  if (old) {
    if (old.digest !== digest) throw new RemoteError('client/conflict', 'Resource operation id reused', {});
    if (old.status !== 'completed') throw new RemoteError('client/uncertain', 'Resource operation requires inspection; it will not be repeated', {});
    return JSON.parse(old.result);
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
    return resources.projects.store.transaction(() => {
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
        for (const [table, values] of [['segments', operation.segments], ['subtitleTracks', operation.tracks]] as const) {
          const existing = (db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL').all(owner, table) as { value: string }[]).map(row => JSON.parse(row.value));
          let next = existing.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
          const mutations = existing.filter(row => row.videoId === operation.courseId).map(row => ({ id: crypto.randomUUID(), table, key: row.id, before: row, after: null as Record<string, unknown> | null }));
          for (const value of values) { const key = next++; mutations.push({ id: crypto.randomUUID(), table, key, before: null, after: { ...value, id: key, videoId: operation.courseId } }); }
          if (mutations.length) records.apply(owner, mutations);
        }
        changes = { status: operation.primary ? 'transcribed' : 'new' };
      } else {
        const ids = [...operation.pin, ...operation.drop];
        if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || !records.get(owner, 'skills', id))) throw new RemoteError('gateway/bad-request', 'Invalid course skills', {});
        changes = { skillOverride: { pin: operation.pin, drop: operation.drop } };
      }
      const result = { ...course, ...changes };
      records.apply(owner, [{ id: `resource-${request.operationId}`, table: 'videos', key: operation.courseId, before: course, after: result }]);
      db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'completed',?)")
        .run(owner, request.operationId, digest, JSON.stringify(result));
      return result as RuntimeJson;
    });
  }
  if ('projectId' in operation && !['restore', 'deleteTrash'].includes(operation.kind)) resources.projects.get(owner, operation.projectId);
  if (operation.kind === 'move') resources.projects.writable(owner, operation.targetProjectId);
   if (operation.kind === 'createDirectory' || operation.kind === 'saveProjectText' || operation.kind === 'upload') {
    resources.projects.writable(owner, operation.projectId);
    resources.projects.assertIdle(operation.projectId);
   }
   if (operation.kind === 'upload') {
     if (!Number.isSafeInteger(operation.size) || operation.size < 0 || !/^[a-f0-9]{64}$/.test(operation.sha256)
       || !operation.path || operation.path.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(operation.path)
       || operation.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid_resource_upload');
     const admission = { operation, phase: 'admitted' };
     db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'pending',?)")
       .run(owner, request.operationId, digest, JSON.stringify(admission));
     return { operationId: request.operationId, upload: true };
   }
  db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status) VALUES(?,?,?,'pending')").run(owner, request.operationId, digest);
  try {
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
      case 'move': resources.move(owner, operation.projectId, operation.path, operation.targetProjectId, operation.target, operation.revision); result = { moved: true }; break;
      case 'remove': resources.remove(owner, operation.projectId, operation.path, operation.revision); result = { deleted: true }; break;
      case 'trash': resources.trash(owner, operation.projectId); break;
      case 'restore': resources.restoreTrash(owner, operation.projectId); break;
      case 'deleteTrash': resources.deleteTrash(owner, operation.projectId); break;
      case 'saveCourseText': result = resources.saveText(owner, operation.courseId, operation.text, operation.expected); break;
      case 'saveMarkdown': result = resources.saveMarkdown(owner, operation); break;
      case 'organizeCourses': result = resources.organizeCourses(owner, operation.folders); break;
      case 'moveLibrarySelection': result = resources.moveSelection(owner, operation.placements); break;
      case 'saveProjectText': result = resources.projects.files.write(operation.projectId, operation.path, operation.text, operation.expectedRevision); break;
    }
    const value = JSON.parse(JSON.stringify(result ?? null)) as RuntimeJson;
    resources.projects.store.transaction(() => {
      db.prepare("UPDATE client_commands SET status='completed',result=? WHERE owner_id=? AND operation_id=?").run(JSON.stringify(value), owner, request.operationId);
      db.prepare("INSERT INTO client_changes(owner_id,domain,entity) VALUES(?,'resources',?)").run(owner, request.operationId);
    });
    return value;
  } catch (error) {
    db.prepare('UPDATE client_commands SET error=? WHERE owner_id=? AND operation_id=?').run(error instanceof Error ? error.message : 'resource_failed', owner, request.operationId);
    throw new RemoteError('client/uncertain', 'Resource handler started; inspect original draft, receipt and directory before retrying', {});
  }
}
