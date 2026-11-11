import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudTaskRunner, taskDto, listOwnerTasks } from '../apps/api/src/cloud/tasks.ts';
import { submitOwnerTask } from '../apps/api/src/cloud/task-commands.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/task-attachment-projections-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store);
const owner = crypto.randomUUID(), now = new Date().toISOString();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, now);
const image = 'data:image/png;base64,PRIVATE_VISUAL_PAYLOAD';
const originalId = crypto.randomUUID();
const file = { id: 'one', serverId: originalId, previewServerId: crypto.randomUUID(), width: 80, height: 60, name: 'original', mimeType: 'image/png', size: 20, text: 'extracted' };
const input = { sessionId: 100, text: 'intent', attachments: [file], _pluginProviders: ['old-plugin'] };
const operationId = crypto.randomUUID(), id = crypto.randomUUID();
store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, operationId, 'chat', 'session:100', JSON.stringify(input), 'completed', now, now);
let runner;
try {
  const command = { operationId, kind: 'chat', resource: 'session:100', input: { ...input, _pluginProviders: [] } };
  // No file or session exists now: the durable receipt must remain replayable.
  assert.equal(submitOwnerTask(store, records, {}, owner, command).id, id);
  assert.equal(submitOwnerTask(store, records, {}, owner, { ...command, input: { ...command.input, attachments: [{ ...file, previewServerId: 'changed', width: 123, dataUrl: image }] } }).id, id);
  for (const replacement of [{ ...command.input, text: 'different' }, { ...command.input, attachments: [{ ...file, serverId: crypto.randomUUID() }] }, { ...command.input, attachments: [{ ...file, text: 'changed extraction' }] }]) {
    assert.throws(() => submitOwnerTask(store, records, {}, owner, { ...command, input: replacement }), /task_nonce_conflict/);
  }
  assert.throws(() => submitOwnerTask(store, records, {}, owner, { ...command, operationId: crypto.randomUUID() }), /不存在或无权访问/);
  for (const kind of ['chat', 'qa']) {
    const row = { id: crypto.randomUUID(), kind, resource: 'session:100', status: 'running', created_at: now,
      input: JSON.stringify({ sessionId: 100, text: 'visible', attachments: [{ ...file, dataUrl: image }], images: [{ type: 'image_url', image_url: { url: image } }], chatImages: [{ dataUrl: image, timestamp: 5 }] }),
      progress: JSON.stringify({ phase: 'answer', content: 'visible response', modelTranscript: [{ image_url: { url: image } }] }), result: JSON.stringify({ content: 'done', nested: { dataUrl: image } }) };
    for (const detail of ['full', 'activity', 'session']) {
      const dto = taskDto(row, detail);
      assert.ok(!JSON.stringify(dto).includes('PRIVATE_VISUAL_PAYLOAD'));
      if (detail === 'activity') { assert.equal(dto.input.text, undefined); assert.equal(dto.input.sessionId, 100); }
      else { assert.equal(dto.input.text, 'visible'); assert.equal(dto.input.attachments[0].serverId, originalId); }
    }
  }
  const qaId = crypto.randomUUID();
  const qaInput = { sessionId: 200, images: [{ type: 'image_url', image_url: { url: image } }], chatImages: [{ dataUrl: image }] };
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(qaId, owner, qaId, 'qa', 'session:200', JSON.stringify(qaInput), 'queued', now, now);
  assert.ok(!JSON.stringify(listOwnerTasks(store, owner, 'activity')).includes('PRIVATE_VISUAL_PAYLOAD'));
  let seen;
  runner = new CloudTaskRunner(store, { records, executors: { node: async context => { seen = context.task.input; return { content: 'done' }; } } });
  runner.start('http://127.0.0.1:1');
  const until = Date.now() + 5000;
  while (!seen && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen, qaInput, 'private DTO stripping must never affect executor QA vision');
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT input FROM cloud_tasks WHERE id=?').get(qaId).input), qaInput);
  console.log('PASS task attachment projections: full/activity/session private visual bytes removed, original refs retained, QA executor images intact, nonce after original/session removal, changed semantic rejection, new admission ownership validation');
} finally { await runner?.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
