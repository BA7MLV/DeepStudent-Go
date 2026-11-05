import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { ResourceFiles } from '../apps/api/src/projects/resources.ts';
import { executeResourceCommand, recoverResourceCommands } from '../apps/api/src/realtime/resources.ts';
import { journaledResourceCommand, recoverResourceWorkflow, resourceScope } from '../apps/api/src/realtime/resource-workflows.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/resource-recovery-');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
const projects = new ProjectRepository(store, path.join(directory, 'files/projects'));
const resources = new ResourceFiles(projects, path.join(directory, 'files'));
const owner = crypto.randomUUID();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, 'Recovery test', new Date().toISOString());
const scope = resourceScope(resources, owner);
const command = operation => ({ operationId: `resource-${crypto.randomUUID()}`, operation, scope });
const execute = request => executeResourceCommand(resources, owner, request);
const receipt = request => store.db.prepare('SELECT * FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId);
const crash = (request, checkpoint) => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/fixtures/resource-crash-child.mjs', JSON.stringify({ directory, owner, command: request, checkpoint })], { encoding: 'utf8' });
  assert.equal(child.status, 86, child.stderr || child.stdout);
};
const physical = (id, filename) => path.join(projects.files.root, id, filename);
try {
  resources.list(owner);
  const project = execute(command({ kind: 'createFolder', name: 'Crash recovery' }));
  for (const checkpoint of ['prepared', 'write', 'committed']) {
    const filename = `${checkpoint}.md`;
    projects.files.write(project.id, filename, 'original', null);
    const original = projects.files.read(project.id, filename);
    const request = command({ kind: 'saveProjectText', projectId: project.id, path: filename, text: 'retained replacement', expectedRevision: original.revision });
    crash(request, checkpoint);
    if (checkpoint === 'committed') assert.equal(receipt(request).status, 'completed');
    else assert.equal(receipt(request).status, 'pending');
    recoverResourceCommands(resources);
    assert.equal(receipt(request).status, 'completed', `${checkpoint} recovers without a browser`);
    assert.equal(projects.files.read(project.id, filename).text, 'retained replacement');
    const actual = projects.files.read(project.id, filename).revision;
    assert.deepEqual(execute(request), JSON.parse(receipt(request).result));
    assert.equal(projects.files.read(project.id, filename).revision, actual, 'duplicate is a receipt, not another write');
  }
  const undo = projects.files.read(project.id, 'write.md');
  const undoRequest = command({ kind: 'saveProjectText', projectId: project.id, path: 'write.md', text: 'restartable rollback', expectedRevision: undo.revision });
  crash(undoRequest, 'write'); crash(undoRequest, 'during-rollback');
  recoverResourceCommands(resources);
  assert.equal(receipt(undoRequest).status, 'completed', 'recovery itself survives process death');
  assert.equal(projects.files.read(project.id, 'write.md').text, 'restartable rollback');

  for (const kind of ['move', 'remove']) {
    const filename = `${kind}.md`;
    projects.files.write(project.id, filename, `keep ${kind}`, null);
    const entry = projects.files.list(project.id).find(row => row.path === filename);
    // Materialize its learning identity before the crash as well.
    const course = resources.list(owner, project.id).entries.find(row => row.path === filename);
    const request = command(kind === 'move' ? { kind, projectId: project.id, path: filename, targetProjectId: project.id, target: `moved-${filename}`, revision: entry.revision }
      : { kind, projectId: project.id, path: filename, revision: entry.revision });
    crash(request, kind);
    recoverResourceCommands(resources);
    assert.equal(receipt(request).status, 'completed', `${kind} recovers with its original CAS`);
    assert.equal(fs.existsSync(physical(project.id, filename)), false);
    if (kind === 'move') assert.equal(resources.list(owner, project.id).entries.find(row => row.path === `moved-${filename}`).courseId, course.courseId, 'move metadata and file preserve one identity');
    else assert.equal(resources.records.get(owner, 'videos', course.courseId), null, 'removal metadata commits with the receipt');
  }
  const create = command({ kind: 'createFolder', name: 'Exactly one recovered folder' });
  crash(create, 'create'); recoverResourceCommands(resources);
  assert.equal(receipt(create).status, 'completed');
  assert.equal(projects.list(owner).filter(row => row.name === create.operation.name).length, 1);
  const mkdir = command({ kind: 'createDirectory', projectId: project.id, path: 'recovered-directory' });
  crash(mkdir, 'mkdir'); recoverResourceCommands(resources);
  assert.equal(receipt(mkdir).status, 'completed');

  projects.files.write(project.id, 'external.md', 'original external draft', null);
  const external = command({ kind: 'saveProjectText', projectId: project.id, path: 'external.md', text: 'our attempted replacement', expectedRevision: projects.files.read(project.id, 'external.md').revision });
  crash(external, 'write');
  const installed = fs.statSync(physical(project.id, 'external.md'));
  fs.writeFileSync(physical(project.id, 'external.md'), 'newer external content!!!');
  fs.utimesSync(physical(project.id, 'external.md'), installed.atime, installed.mtime);
  recoverResourceCommands(resources);
  assert.equal(receipt(external).status, 'pending', 'external changes prevent automatic rollback/replay');
  assert.equal(fs.readFileSync(physical(project.id, 'external.md'), 'utf8'), 'newer external content!!!');
  assert.equal(store.db.prepare('SELECT last_error FROM resource_workflows WHERE operation_id=?').get(external.operationId).last_error, 'resource_rollback_conflict');
  assert.throws(() => execute(external), error => error.code === 'client/uncertain');
  let redispatched = false;
  assert.throws(() => journaledResourceCommand(resources, owner, external, receipt(external).digest, '', () => { redispatched = true; return null; }), error => error.code === 'client/uncertain');
  assert.equal(redispatched, false, 'writer-lock recheck rejects uncertain effects left after a concurrent preflight');

  for (const committed of [false, true]) {
    const filename = committed ? 'cleanup-failure.md' : 'missing-manifest.md';
    const request = command({ kind: 'saveProjectText', projectId: project.id, path: filename, text: 'preserve execution evidence', expectedRevision: null });
    crash(request, committed ? 'committed' : 'write');
    const token = crypto.createHash('sha256').update(JSON.stringify([owner, request.operationId])).digest('hex');
    const journal = path.join(path.dirname(projects.files.root), '.resource-journal', token);
    fs.unlinkSync(path.join(journal, 'manifest.json'));
    assert.doesNotThrow(() => recoverResourceWorkflow(resources, owner, request.operationId));
    assert.equal(receipt(request).status, committed ? 'completed' : 'pending');
    assert.equal(fs.readFileSync(physical(project.id, filename), 'utf8'), 'preserve execution evidence');
    if (committed) assert.deepEqual(execute(request), JSON.parse(receipt(request).result), 'failed diagnostic cleanup cannot hide a completed outcome');
    else assert.throws(() => execute(request), error => error.code === 'client/uncertain', 'a missing manifest with retained evidence is not an empty workflow');
  }

  const legacy = command({ kind: 'createDirectory', projectId: project.id, path: 'legacy-never-replay' });
  store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status) VALUES(?,?,?,'pending')").run(owner, legacy.operationId,
    crypto.createHash('sha256').update(JSON.stringify({ kind: 'resource', operation: Object.fromEntries(Object.entries(legacy.operation).sort(([a], [b]) => a.localeCompare(b))) })).digest('hex'));
  recoverResourceCommands(resources);
  assert.equal(fs.existsSync(physical(project.id, 'legacy-never-replay')), false, 'legacy uncertainty is not replay authority');

  const course = resources.list(owner, project.id).entries.find(row => row.path === 'prepared.md');
  const stream = crypto.randomUUID();
  const newest = { ...command({ kind: 'recordReadingPosition', courseId: course.courseId, unit: 9 }), delivery: { stream, sequence: 20 } };
  const older = { ...command({ kind: 'recordReadingPosition', courseId: course.courseId, unit: 2 }), delivery: { stream, sequence: 19 } };
  execute(newest); execute(older);
  assert.equal(resources.records.get(owner, 'videos', course.courseId).lastUnit, 9, 'late older progress cannot rewind the same browser stream');
  assert.equal(receipt(older).status, 'completed');
  execute({ ...command({ kind: 'recordPlayback', courseId: course.courseId, position: 5 }), delivery: { stream, sequence: 30 } });
  execute({ ...command({ kind: 'recordPlayback', courseId: course.courseId, position: 100, finished: true }), delivery: { stream, sequence: 29 } });
  let playback = resources.records.get(owner, 'videos', course.courseId);
  assert.equal(playback.lastPosition, 5, 'older playback cannot rewind a newer position');
  assert.equal(playback.finished, 1, 'a position-only update must not lose an explicit completion');
  execute({ ...command({ kind: 'recordPlayback', courseId: course.courseId, position: 0, finished: false }), delivery: { stream, sequence: 31 } });
  execute({ ...command({ kind: 'recordPlayback', courseId: course.courseId, position: 100, finished: true }), delivery: { stream, sequence: 28 } });
  playback = resources.records.get(owner, 'videos', course.courseId);
  assert.equal(playback.lastPosition, 0); assert.equal(playback.finished, 0, 'explicit restart wins over an older completion');
  assert.throws(() => execute({ ...command({ kind: 'remove', projectId: project.id, path: 'prepared.md', revision: projects.files.read(project.id, 'prepared.md').revision }), scope: crypto.randomUUID() }), error => error.details.code === 'resource_scope_changed');
  assert.equal(fs.existsSync(physical(project.id, 'prepared.md')), true, 'old account database scope cannot delete current files');
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('PASS real process-death recovery before/after file effects and SQL commit; interrupted rollback; move/remove/create metadata; external-edit preservation; scoped dedupe and ordered progress', directory);
} finally { store.close(); }
