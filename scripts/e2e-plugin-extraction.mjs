import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Readable } from 'node:stream';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/plugin-extraction-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const reservation = net.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r)); const port = reservation.address().port; await new Promise(r => reservation.close(r));
const origin = `http://localhost:${port}`; process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const { receiveFile } = await import('../apps/api/src/cloud/files.ts');
const fixture = async (_url, init) => {
  assert.ok(JSON.parse(init.body).messages);
  const content='```quiz\n'+JSON.stringify({questions:[{stem:'真实工具保存的部分提取。',options:['是','否'],answer:0,explanation:'原文答案',answerSource:'original',source:{courseId:'extraction-source',name:'权限链路原题资料',page:1}}]})+'\n```';
  return Response.json({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]});
};
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: fixture });
let browser, web, store;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
   web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { watch: null, hmr: false, host: 'localhost', port, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false, ws: true } } } });
  await web.listen(); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  let holdInteractive = false;
  const workerMutations = [];
  await context.route(/\/api\/(?:v1\/cloud\/records|clientRuntime\/(?:commitRecords|editLearning)|executorRuntime\/(?:commitArtifacts|resourceCommand))(?:\?|$)/, async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const worker = request.headers().authorization?.startsWith('Bearer ');
      if (worker) { const body = request.postDataJSON().payload.args.request; workerMutations.push(...(body.products ?? [body.operation])); }
      else if (holdInteractive) return route.fulfill({ status: 503, json: { error: 'fixture_hold_interactive_outbox' } });
    }
    await route.continue();
  });
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'plugins-ui-password-123' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const owner = (await (await post('/auth/password/login', { password: 'plugins-ui-password-123' })).json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store), id = 'extraction-source', bankId = `__course_questions__${id}`;
  const material = { id, name: '权限链路原题资料', kind: 'material', materialFormat: 'md', mimeType: 'text/markdown', duration: 0, createdAt: Date.now(), status: 'transcribed' };
  const question = { stem: '原题保留了吗？', options: ['是', '否'], answer: 0, explanation: '原文给出的答案是。', answerSource: 'original', source: { courseId: id, name: material.name, page: 1 } };
  const bytes = Buffer.from(`# 原题\n\n\`\`\`quiz\n${JSON.stringify({ questions: [question] })}\n\`\`\`\n`);
  const file = await receiveFile(store, path.join(directory, 'files'), owner, Readable.from([bytes]), 'questions.md', 'text/markdown', bytes.length, bytes.length);
  records.apply(owner, [{id:'source-file',table:'files',key:id,before:null,after:{id,blob:{$file:file.id}}},{id:'source-block',table:'materialBlocks',key:1,before:null,after:{id:1,materialId:id,idx:0,text:bytes.toString()}}, { id: 'source', table: 'videos', key: id, before: null, after: material }, { id: 'bank', table: 'videos', key: bankId, before: null, after: { ...material, id: bankId, name: '原题题库.md' } }, { id: 'file', table: 'files', key: bankId, before: null, after: { id: bankId, blob: { $file: file.id } } }]);
  const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
  configuration.save(owner, { ...configuration.get(owner), policy: { ...configuration.get(owner).policy, read: 'allow', write: 'allow' }, providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-chat', apiKey: 'fixture', baseUrl: 'https://fixture.example/v1', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture-model' } });
  const page = await context.newPage(), requests = [];
   page.on('request', request => { if (/\/cloud\/(records|tasks\/.*authorize)|\/(clientRuntime\/(commitRecords|editLearning)|executorRuntime\/(commitArtifacts|resourceCommand))/.test(request.url()) && request.method() === 'POST') requests.push({ url: request.url(), body: request.postDataJSON(), permissions: store.db.prepare('SELECT id,capability,status FROM cloud_permissions').all() }); });
  await page.goto(`${origin}/#/board`); await page.getByTestId('board-plugin-todo').waitFor({ timeout: 30000 });
  const instance = await page.evaluate(async id => (await (await import('/src/plugins/legacy-actions.ts')).materialPluginInstance('practice', id)).instance.id, id);
  await page.goto(`${origin}/#/plugins/${instance}`);
  await page.getByRole('button', { name: '提取原题为题库', exact: true }).waitFor();
  holdInteractive = true;
  const pendingId = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    await db.studyDays.put({ date: '2026-01-01', seconds: 60, updatedAt: Date.now() });
    return (await db.table('_cloudOutbox').toArray()).find(row => row.table === 'studyDays' && row.key === '2026-01-01').id;
  });
  await page.getByRole('button', { name: '提取原题为题库', exact: true }).click();
  try { await page.getByText('题库现有 2 道原题', { exact: false }).waitFor({ timeout: 30000 }); }
  catch (error) {
    console.error('Receipt diagnostics', store.db.prepare('SELECT * FROM plugin_learning_tasks').all(), await page.locator('body').innerText());
    console.error(JSON.stringify({ requests: requests.slice(0, 40).map(r => ({ ...r, body: r.body.mutations ? r.body.mutations.map(({ table, key, permissionId, baseRevision }) => ({ table, key, permissionId, baseRevision })) : r.body })), tasks: store.db.prepare('SELECT status,error,progress FROM cloud_tasks').all(), permissions: store.db.prepare('SELECT * FROM cloud_permissions').all(), outbox: await page.evaluate(async () => (await import('/src/store/db.ts')).db.table('_cloudOutbox').toArray().then(rows => rows.map(({ table, key, permissionId }) => ({ table, key, permissionId })))) }, null, 2));
    throw error;
  }
  const task = store.db.prepare("SELECT * FROM cloud_tasks WHERE kind='qa'").get();
  assert.equal(task.status, 'completed'); assert.equal(task.executor, 'node');
  assert.ok(JSON.parse(task.progress).questionBankSaved);
  const saved = store.db.prepare('SELECT project_id,path FROM resource_files WHERE owner_id=? AND course_id=?').get(owner, bankId);
  const text = fs.readFileSync(path.join(directory, 'files/projects', saved.project_id, saved.path), 'utf8');
  assert.ok(text.includes('真实工具保存的部分提取。')); assert.ok(text.includes(question.stem));
  assert.equal(workerMutations.length,0,'server task never submits browser bearer mutations');
  assert.ok(workerMutations.every(row => row.kind !== 'studyTime'), 'executor cannot drain the UI queue even during tool flush');
  assert.ok(await page.evaluate(async pendingId => (await (await import('/src/store/db.ts')).db.table('_cloudOutbox').toArray()).some(row => row.id === pendingId), pendingId), 'UI edit stays pending until its own upload is allowed');
  holdInteractive = false;
  await page.evaluate(async () => (await import('/src/cloud/sync.ts')).flushCloud());
  assert.equal(records.get(owner, 'studyDays', '2026-01-01').seconds, 60, 'retained edit eventually commits through the account client');
  const screenshots = process.env.SCREENSHOT_DIR ?? path.join(directory, 'screenshots');
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, 'learning-extraction-success.png') });
  console.log('Plugin UI + server extraction passed: original Markdown preserved, durable receipt, no bearer mutations and independent UI outbox retained.');
} finally {
  await browser?.close(); await web?.close(); store?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true });
}
