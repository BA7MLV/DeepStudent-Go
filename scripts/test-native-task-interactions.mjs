import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { ResourceFiles } from '../apps/api/src/projects/resources.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { editCourseMarkdown, awaitTaskAnswer } from '../apps/api/runtime/task-interactions.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/native-task-interactions-');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const owner = crypto.randomUUID(), now = new Date().toISOString();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, 'Fixture', now);
const resources = new ResourceFiles(new ProjectRepository(store, path.join(directory, 'projects')), path.join(directory, 'files'));
const checks = [];
const wait = async predicate => {
  for (let i = 0; i < 100; i++) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('fixture_wait_timeout');
};
function fixture() {
  const id = crypto.randomUUID(), courseId = crypto.randomUUID(), controller = new AbortController();
  resources.saveMarkdown(owner, { courseId, text: 'original body', expected: '', createOnly: true, name: 'Fixture' });
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,'chat',?,?,'running',?,?)").run(id, owner, id, `session:${id}`, '{}', now, now);
  let policy = 'ask';
  const context = { owner, store, records: new CloudRecords(store), filesDir: resources.filesDir, signal: controller.signal, task: { id }, pluginService: { learningOptions: { resources } }, configuration: { taskPolicy: () => ({ read: 'allow', write: policy }), audit() {} }, checkActive() {
    controller.signal.throwIfAborted();
    const task = store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(id);
    if (!task || !['running', 'waiting_user'].includes(task.status)) throw new Error('task_inactive');
  } };
  return { id, courseId, controller, context, policy: value => { policy = value; }, args: { path: `/courses/${courseId}/material`, edits: [{ old_string: 'original', new_string: 'approved' }] }, permission: () => store.db.prepare('SELECT * FROM cloud_permissions WHERE task_id=?').get(id), read: () => {
    const file = resources.openCourse(owner, courseId); try { return fs.readFileSync(file.fd, 'utf8'); } finally { fs.closeSync(file.fd); }
  } };
}
try {
  const approved = fixture(); const approvedWork = editCourseMarkdown(approved.context, approved.args);
  const permission = await wait(approved.permission); assert.equal(permission.status, 'pending'); assert.equal(approved.read(), 'original body');
  assert.equal(store.db.prepare("UPDATE cloud_permissions SET status='approved' WHERE id=? AND status='pending'").run(permission.id).changes, 1);
  await approvedWork; assert.equal(approved.read(), 'approved body'); assert.equal(approved.permission().status, 'finished');
  assert.equal(store.db.prepare("UPDATE cloud_permissions SET status='approved' WHERE id=? AND status IN ('pending','approved')").run(permission.id).changes, 0);
  checks.push('durable approval, exact CAS, one consume and duplicate rejection');

  const raced = fixture(); const racedWork = editCourseMarkdown(raced.context, raced.args); const racePermission = await wait(raced.permission);
  resources.saveMarkdown(owner, { courseId: raced.courseId, text: 'concurrent body', expected: 'original body' });
  store.db.prepare("UPDATE cloud_permissions SET status='approved' WHERE id=?").run(racePermission.id);
  await assert.rejects(racedWork); assert.equal(raced.read(), 'concurrent body'); checks.push('concurrent source change not overwritten after approval');

  const revoked = fixture(); const revokedWork = editCourseMarkdown(revoked.context, revoked.args); await wait(revoked.permission); revoked.policy('deny');
  await assert.rejects(revokedWork, /write_permission_revoked/); assert.equal(revoked.read(), 'original body'); checks.push('policy revocation preserves original bytes');

  const cancelled = fixture(); const cancelledWork = editCourseMarkdown(cancelled.context, cancelled.args); await wait(cancelled.permission);
  store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(cancelled.id);
  await assert.rejects(cancelledWork, /task_inactive/); assert.equal(cancelled.read(), 'original body');
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(cancelled.id).status, 'cancelled'); checks.push('cancel cannot revive task or write');

  const denied = fixture(); denied.policy('deny'); await assert.rejects(editCourseMarkdown(denied.context, denied.args), /write_permission_denied/); assert.equal(denied.permission(), undefined);
  const missing = fixture(); store.db.prepare('DELETE FROM cloud_tasks WHERE id=?').run(missing.id);
  await assert.rejects(editCourseMarkdown({ ...missing.context, checkActive() {} }, missing.args), /native_edit_task_scope_denied/); checks.push('deny and missing task never admit write');

  const asking = fixture(), ask = { question: '原始问题', type: 'single', options: [{ id: 'keep', label: '保留' }, { id: 'stop', label: '停止' }] };
  const answerWork = awaitTaskAnswer(asking.context, ask);
  const command = value => store.db.prepare("INSERT INTO cloud_task_commands(task_id,nonce,action,value) VALUES(?,?,'answerAsk',?)").run(asking.id, crypto.randomUUID(), JSON.stringify(value));
  command({ status: 'answered', mode: 'selection', selectedIds: ['forged'], selectedLabels: ['forged'], text: '', note: '' });
  await wait(() => store.db.prepare('SELECT consumed FROM cloud_task_commands WHERE task_id=?').get(asking.id)?.consumed);
  command('保留'); const answer = await answerWork; assert.deepEqual(answer.answer.selectedIds, ['keep']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cloud_task_commands WHERE task_id=? AND consumed=0').get(asking.id).n, 0); checks.push('invalid answer consumed without continuing; valid durable answer resumes');
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ pass: true, checks }, null, 2));
  console.log(`PASS native task approval/CAS/cancel/answer (${directory})`);
} finally { store.close(); }
