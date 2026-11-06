import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { listOwnerTasks } from '../apps/api/src/cloud/tasks.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/task-projections-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const owner = crypto.randomUUID();
const now = new Date().toISOString();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, now);
const insert = (id, kind, status, progress, result = null, sessionId = 1) => store.db.prepare(`INSERT INTO cloud_tasks
  (id,owner_id,nonce,kind,resource,input,status,progress,result,error,created_at,updated_at,executor)
  VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?)`).run(id, owner, id, kind, 'r', JSON.stringify({ sessionId }), status,
  progress === null ? null : JSON.stringify(progress), result === null ? null : JSON.stringify(result), now, now, 'node');

const transcript = { version: 1, messages: [{ role: 'assistant', content: 'secret transcript' }] };
insert('done-chat', 'chat', 'completed', { phase: 'answer', content: 'final answer', modelTranscript: transcript }, { content: 'final answer', rowId: 2 });
insert('done-cards', 'cards', 'completed', { phase: 'done', done: 3, total: 3, message: '卡片已生成' }, { count: 3 });
insert('active-chat', 'chat', 'running', { phase: 'answer', content: 'streaming text', modelTranscript: transcript });
insert('active-qa', 'qa', 'running', { phase: 'answer', content: 'qa streaming', modelTranscript: transcript });
insert('other-session', 'chat', 'running', { phase: 'answer', content: 'other session' }, null, 2);

const byId = tasks => new Map(tasks.map(task => [task.id, task]));
const activity = byId(listOwnerTasks(store, owner, 'activity'));
assert.equal(activity.get('done-chat').progress, null, 'finished chat progress is not a second answer copy');
assert.equal(activity.get('done-chat').result, null, 'finished results stay out of the activity stream');
assert.deepEqual(activity.get('done-cards').progress, { phase: 'done', done: 3, total: 3, message: '卡片已生成' },
  'finished job counters survive for the cards UI');
assert.deepEqual(activity.get('active-chat').progress, { phase: 'answer' },
  'the global list gets chat status, not its open answer');
assert.equal(activity.get('active-qa').progress.content, 'qa streaming', 'the legacy QA activity still receives its text');
assert.equal(activity.get('active-qa').progress.modelTranscript, undefined);

const sessionTasks = listOwnerTasks(store, owner, 'session', 1);
const session = byId(sessionTasks);
assert.equal(session.get('done-chat').progress, null);
assert.equal(session.get('active-chat').progress.content, 'streaming text', 'the open conversation keeps its live text');
assert.equal(session.get('active-chat').progress.modelTranscript, undefined, 'session progress never duplicates modelTrace');
assert.equal(session.has('other-session'), false, 'a session projection never reads every task of the account');
assert.equal(listOwnerTasks(store, owner, 'session', 2).some(task => task.id === 'other-session'), true);

const full = byId(listOwnerTasks(store, owner));
assert.deepEqual(full.get('done-chat').result, { content: 'final answer', rowId: 2 });
assert.deepEqual(full.get('done-chat').progress, { phase: 'answer', content: 'final answer', modelTranscript: transcript });

const latest = entity => store.db.prepare('SELECT domain FROM client_changes WHERE owner_id=? AND entity=? ORDER BY revision DESC LIMIT 1').get(owner, entity);
store.db.prepare("UPDATE cloud_tasks SET progress=?,updated_at=? WHERE id='active-chat'").run(JSON.stringify({ phase: 'answer', content: 'next' }), now);
assert.equal(latest('active-chat').domain, 'cloud_task_progress', 'chat progress bypasses the 200-row activity watcher');
store.db.prepare("UPDATE cloud_tasks SET progress=?,updated_at=? WHERE id='active-qa'").run(JSON.stringify({ phase: 'answer', content: 'next' }), now);
assert.equal(latest('active-qa').domain, 'cloud_tasks', 'other task kinds still wake their job UI');
store.db.prepare("UPDATE cloud_tasks SET status='completed',result='{}',updated_at=? WHERE id='active-chat'").run(now);
assert.equal(latest('active-chat').domain, 'cloud_tasks', 'terminal state still reaches the activity list');

store.close();
fs.rmSync(directory, { recursive: true, force: true });
console.log('PASS: task projections keep live text in the session stream and historical payloads out of the activity stream');
