import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { unzipSync, strFromU8 } from 'fflate';
import { createCanvas } from '@napi-rs/canvas';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { submitOwnerTask } from '../apps/api/src/cloud/task-commands.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { persistHandout } from '../apps/api/runtime/handout-edit.ts';
import { parseHandoutPersist } from '../apps/api/src/cloud/handout-edit.ts';

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'handout-persist-'));
// Isolated targeted runtime build: production workers resolve sibling .mjs URLs.
// Never overwrite shared dist output while other agents are testing/building.
fs.symlinkSync(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'dir');
await build({ entryPoints: ['apps/api/runtime/node.ts', 'apps/api/runtime/image-process.ts'], outdir: directory, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
const { executeNodeTask } = await import(pathToFileURL(path.join(directory, 'node.mjs')).href);
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store), configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const filesDir = path.join(directory, 'files'); fs.mkdirSync(filesDir);
const owner = crypto.randomUUID(), other = crypto.randomUUID(), now = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, now);
const put = (table, key, after, account = owner) => records.apply(account, [{ id: crypto.randomUUID(), table, key, before: records.get(account, table, key), after }]);
const get = id => taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
let onRender;
const runner = new CloudTaskRunner(store, { records, configuration, filesDir, fetch: async () => { throw new Error('persist_must_not_call_model'); }, executors: { node: async context => { const pending = executeNodeTask(context); onRender?.(); return pending; } } });
const sections = text => [{ heading: '第一节', blocks: [{ type: 'lead', text }, { type: 'table', header: ['A', 'B'], rows: [['一', '二']] }, { type: 'list', ordered: true, items: ['保留项目'] }] }];
const baseline = row => ({ sectionsJson: row.sectionsJson, outlineJson: row.outlineJson, blob: row.blob });
const command = (row, text = '服务器保存结构化讲义') => ({ kind: 'handoutEdit', resource: `handout:${row.id}`, operationId: crypto.randomUUID(), input: { action: 'persist', videoId: row.videoId, handoutId: row.id, sections: sections(text), summary: '新的摘要', expected: baseline(row) } });
async function until(id) { const end = Date.now() + 15000; while (Date.now() < end) { const task = get(id); if (['completed', 'failed', 'cancelled'].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('handout_persist_timeout'); }
const fileBytes = id => fs.readFileSync(path.join(filesDir, store.db.prepare('SELECT storage_name FROM files WHERE id=? AND owner_id=?').get(id, owner).storage_name));
try {
  const originalBytes = Buffer.from('original immutable document bytes');
  const file = await receiveFile(store, filesDir, owner, Readable.from([originalBytes]), 'original.docx', 'application/octet-stream', 1024);
  put('videos', 'course', { id: 'course', name: '课程', fileDeleted: true });
  put('videos', 'other-course', { id: 'other-course', name: '其他课程' });
  put('handouts', 101, { id: 101, videoId: 'course', title: '原讲义', createdAt: Date.now(), blob: { $file: file.id }, outlineJson: JSON.stringify({ title: '原讲义', summary: '旧摘要', sections: [{ heading: '第一节' }] }), sectionsJson: JSON.stringify(sections('旧正文')), readPos: { section: 0 } });
  const initial = records.get(owner, 'handouts', 101), request = command(initial);
  assert.throws(() => submitOwnerTask(store, records, configuration, other, request), /handout_not_found/);
  assert.throws(() => submitOwnerTask(store, records, configuration, owner, { ...request, input: { ...request.input, videoId: 'other-course' } }), /handout_not_found/);
  for (const bad of [
    { ...request.input, path: '/etc/passwd' },
    { ...request.input, sections: [{ heading: 'bad', blocks: [{ type: 'table', header: ['A', 'B'], rows: [['one']] }] }] },
    { ...request.input, sections: [{ heading: 'bad', blocks: [{ type: 'figure', ts: -1 }] }] },
    { ...request.input, sections: [{ heading: 'bad', blocks: [{ type: 'unknown', text: 'lost' }] }] },
    { ...request.input, summary: 'x'.repeat(100001) },
  ]) assert.throws(() => parseHandoutPersist(bad), /invalid_handout_persist/);
  const admitted = submitOwnerTask(store, records, configuration, owner, request);
  assert.equal(admitted.frozenModel, undefined, 'IR persistence requires no provider credential or model');
  runner.start('http://127.0.0.1:1');
  const completed = await until(admitted.id); assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const changed = records.get(owner, 'handouts', 101);
  assert.equal(changed.blob.$file, completed.result.fileId);
  const zip = unzipSync(fileBytes(completed.result.fileId));
  assert.match(strFromU8(zip['word/document.xml']), /服务器保存结构化讲义/);
  assert.equal(JSON.parse(changed.outlineJson).title, '原讲义');
  assert.equal(JSON.parse(changed.outlineJson).summary, '新的摘要');
  assert.deepEqual(fileBytes(file.id), originalBytes, 'original bytes never overwritten');
  assert.throws(() => submitOwnerTask(store, records, configuration, owner, { ...request, operationId: crypto.randomUUID() }), /handout_edit_conflict/, 'stale editor baseline rejected');
  const secondRequest = command(changed, '后来编辑');
  const second = await until(submitOwnerTask(store, records, configuration, owner, secondRequest).id); assert.equal(second.status, 'completed');
  const latest = records.get(owner, 'handouts', 101);
  const retry = submitOwnerTask(store, records, configuration, owner, request);
  assert.deepEqual(retry.result, completed.result, 'lost-response retry returns original durable receipt, not latest document');
  assert.equal(records.get(owner, 'handouts', 101).blob.$file, latest.blob.$file);
  assert.deepEqual(await persistHandout({ task: { id: completed.id }, owner, store, checkActive() {} }), completed.result, 'executor replay uses artifact receipt without regenerating or rereading latest baseline');
  const concurrent = command(latest, '应拒绝覆盖');
  onRender = () => { onRender = undefined; put('handouts', 101, { ...records.get(owner, 'handouts', 101), sectionsJson: JSON.stringify(sections('并发修改必须保留')) }); };
  const conflict = await until(submitOwnerTask(store, records, configuration, owner, concurrent).id);
  assert.equal(conflict.status, 'failed'); assert.match(conflict.error, /handout_edit_conflict/);
  assert.match(records.get(owner, 'handouts', 101).sectionsJson, /并发修改必须保留/);
  assert.equal(records.get(owner, 'handouts', 101).blob.$file, latest.blob.$file, 'losing render never publishes a new blob');
  assert.deepEqual(fileBytes(file.id), originalBytes);
  const row = records.get(owner, 'handouts', 101), cancellation = command(row);
  const cancelledTask = submitOwnerTask(store, records, configuration, owner, cancellation);
  store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=?").run(cancelledTask.id);
  const controller = new AbortController();
  const pending = persistHandout({ task: get(cancelledTask.id), owner, store, records, configuration, filesDir, signal: controller.signal, checkActive() { controller.signal.throwIfAborted(); }, report() {} });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(cancelledTask.id);
  assert.deepEqual(records.get(owner, 'handouts', 101), row, 'cancel preserves original context and artifact');
  const canvas = createCanvas(20, 20), drawing = canvas.getContext('2d'); drawing.fillStyle = 'blue'; drawing.fillRect(0, 0, 20, 20);
  const png = canvas.toBuffer('image/png');
  const frameFile = await receiveFile(store, filesDir, owner, Readable.from([png]), 'frame.png', 'image/png', 1024 * 1024);
  put('frames', 201, { id: 201, videoId: 'course', ts: 1, blob: { $file: frameFile.id }, caption: '保留画面' });
  const illustrated = command(row); illustrated.input.sections[0].blocks.push({ type: 'figure', ts: 1, caption: '保留画面' });
  const picture = await until(submitOwnerTask(store, records, configuration, owner, illustrated).id);
  assert.equal(picture.status, 'completed', JSON.stringify(picture));
  const imageZip = unzipSync(fileBytes(picture.result.fileId));
  assert.ok(Object.entries(imageZip).some(([key, value]) => key.startsWith('word/media/') && value.length > 0), 'retained frame images rebuild even when original video was deleted');
  assert.deepEqual(fileBytes(frameFile.id), png, 'render never changes original frame bytes');
  console.log('PASS server handout persist: real DOCX, strict IR, owner/course isolation, admission and render CAS, immutable original bytes, cancellation, no model, original receipt replay.');
} finally { await runner.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
