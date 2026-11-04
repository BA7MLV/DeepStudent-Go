import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner } from '../apps/api/src/cloud/tasks.ts';
import { PluginService } from '../apps/api/src/plugins/service.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';

const root = path.join(os.tmpdir(), 'opencode'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'plugin-material-actions-')), filesDir = path.join(directory, 'files'); fs.mkdirSync(filesDir);
const dbPath = path.join(directory, 'db.sqlite'), store = new DatabaseStore(dbPath, path.join(directory, 'system'));
const owner = crypto.randomUUID(), other = crypto.randomUUID();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
const records = new CloudRecords(store), configuration = new CloudConfiguration(store, path.join(directory, 'config'));
configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-chat', apiKey: 'fixture', baseUrl: 'https://fixture.example/v1', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture-model' } });
const service = new PluginService(store, undefined, undefined, { filesDir });
const runner = new CloudTaskRunner(store, { records, configuration, filesDir, fetch: async (_url, init) => {
  const body = JSON.parse(init.body);
  return Response.json({ choices: [{ message: { content: body.max_tokens === 6000 ? '# 真实资料讲义\n\n只根据原资料生成。' : '[{"time":"00:01","author":"小林","role":"note","text":"这是真实保存的讨论内容","replies":[]}]' } }] });
} });
const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after }]);
const invoke = (action, args, user = owner) => service.invokeNamed(user, 'material-tools', 'tools-a', 1, action, args);
async function end(id) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const row = store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(row.status)) return row;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('task_timeout');
}
try {
  put('videos', 'a', { id: 'a', name: '资料 A', kind: 'material', materialFormat: 'md' });
  put('videos', 'b', { id: 'b', name: '资料 B', kind: 'material', materialFormat: 'md' });
  put('materialBlocks', 1, { id: 1, materialId: 'a', idx: 0, text: '资料 A 的完整知识点。用于验证原任务生成讲义、评论、弹幕。' });
  const source = Buffer.from('# 真实 Markdown\n\n原文件解析结果，不能另建数据源。');
  const file = await receiveFile(store, filesDir, owner, Readable.from([source]), 'source.md', 'text/markdown', source.length, source.length);
  put('files', 'a', { id: 'a', blob: { $file: file.id } });
  const doc = service.files.layout(owner), layout = JSON.parse(doc.content);
  layout.instances.push({ id: 'tools-a', pluginId: 'material-tools', scope: { kind: 'material', id: 'a' } });
  service.files.save(owner, doc.path, JSON.stringify(layout), doc.content, doc.revision);
  assert.throws(() => invoke('comments', { materialId: 'b', clientNonce: 'denied' }), /denied/);
  assert.throws(() => invoke('comments', { materialId: 'a', clientNonce: 'denied' }, other), /not_found/);
  assert.throws(() => invoke('comments', { materialId: 'a', clientNonce: 'injection', input: { owner: other } }), /invalid_plugin_arguments/);
  assert.throws(() => invoke('transcribe', { materialId: 'a', clientNonce: 'document' }), /media_required/);
  const tasks = ['handout', 'comments', 'danmaku', 'material'].map(action => invoke(action, { materialId: 'a', clientNonce: action }));
  assert.equal(invoke('comments', { materialId: 'a', clientNonce: 'comments' }).id, tasks[1].id);
  assert.throws(() => invoke('comments', { materialId: 'a', clientNonce: 'duplicate' }), /generation_conflict/);
  assert.ok(tasks.every(task => task.executor === 'node'));
  const cover = invoke('cover', { materialId: 'a', clientNonce: 'cover', force: false });
  assert.equal(cover.executor, 'node'); assert.equal(cover.input.options.force, false);
  assert.throws(() => invoke('cover', { materialId: 'a', clientNonce: 'cover', force: true }), /nonce_conflict/);
  runner.start('http://127.0.0.1:1');
  for (const task of tasks) { const row = await end(task.id); assert.equal(row.status, 'completed', row.error); }
  const list = table => store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL").all(owner, table).map(row => JSON.parse(row.value));
  assert.equal(list('handouts').filter(r => r.videoId === 'a').length, 1);
  assert.equal(list('comments').filter(r => r.videoId === 'a').length, 1);
  assert.equal(list('danmakus').filter(r => r.videoId === 'a').length, 1);
  assert.ok(list('materialBlocks').some(r => r.materialId === 'a' && r.text.includes('原文件解析结果')));
  assert.equal(list('comments').filter(r => r.videoId === 'b').length, 0);
  const results = service.invoke(owner, 'material-tools', 'tools-a', 1, 'learning.results', { materialId: 'a' });
  assert.equal(results.tasks.length, 5); assert.ok(results.tasks.every(t => t.origin.contextRef.materialId === 'a'));
  const latest = service.files.layout(owner), disabled = JSON.parse(latest.content); disabled.disabledBuiltins = ['material-tools'];
  service.files.save(owner, latest.path, JSON.stringify(disabled), latest.content, latest.revision);
  assert.throws(() => invoke('comments', { materialId: 'a', clientNonce: 'disabled' }), /plugin_unavailable/);
  console.log('Material plugin adapters passed: original native handout/comments/danmaku/Markdown outputs, server cover routing, owner/material/schema guards, durable task origin, nonce binding, duplicate generation, disable revocation.');
} finally { await runner.close(); await service.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
