import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fixtureDomain, fixturePreference } from './fixture-domain.mjs';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/wrongbook-domain-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external calls forbidden'); } });
let vite, browser;
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  const init = await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'wrongbook-domain-password' } });
  assert.equal(init.statusCode, 201);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'wrongbook-domain-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const config = (await api.inject({ method: 'GET', url: '/api/v1/cloud/config', headers: { cookie } })).json();
  const configured = await api.inject({ method: 'PUT', url: '/api/v1/cloud/config', headers: { cookie }, payload: { ...config, providers: [{ id: 'offline', name: 'Offline', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'test-only', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'offline', model: 'test' } } });
  assert.equal(configured.statusCode, 200, configured.body);
  await fixturePreference(api, cookie, 'uiLanguage', 'zh-CN');
  const sourceId = 'wrongbook-source-course';
  const material = await fixtureDomain(api, cookie, 'resourceCommand', { operationId: 'wrongbook-source-markdown-0001', operation: { kind: 'saveMarkdown', courseId: sourceId, name: '错题领域测试.md', text: '# 错题领域测试\n\n真实课程资料。', expected: '', createOnly: true } });
  assert.equal(material.ok, true, JSON.stringify(material));
  const session = { id: 82001, videoId: sourceId, title: '错题领域测试', createdAt: Date.now() };
  const quiz = { data: { questions: [{ stem: '领域错题：选择第二项', options: ['第一项', '第二项'], answer: 1, explanation: '第二项正确。' }] }, picks: [] };
  const seeded = await fixtureDomain(api, cookie, 'editLearning', { operationId: 'wrongbook-domain-session-0001', edits: [
    { mutationId: 'wrongbook-session', kind: 'conversationSession', expected: null, value: session },
    { mutationId: 'wrongbook-user', kind: 'conversationMessage', expected: null, value: { id: 82000, sessionId: session.id, videoId: session.videoId, role: 'user', content: '请给我一道题', createdAt: session.createdAt - 1 } },
    { mutationId: 'wrongbook-quiz', kind: 'conversationMessage', expected: null, value: { id: 82002, sessionId: session.id, videoId: session.videoId, role: 'assistant', content: '请作答', quiz, createdAt: session.createdAt } },
  ] });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'wrongbook-fixture-login', configureServer(server) { server.middlewares.use('/__login', (_req, res) => { res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.writeHead(302, { location: '/#/library' }); res.end(); }); } }] });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/__login`);
  await page.getByTestId('resource-list').waitFor({ timeout: 60000 });
  await page.goto(`${origin}/#/player/${sourceId}`);
  const openAssistant = page.getByRole('button', { name: '打开学习助手', exact: true });
  await page.getByTestId('study-assistant-toggle').waitFor({ timeout: 60000 });
  if (await openAssistant.isVisible()) await openAssistant.click();
  const question = page.locator('.quiz-q').first();
  try { await question.waitFor(); }
  catch (error) { console.error('Wrongbook quiz page:', await page.locator('body').innerText(), errors); throw error; }
  let writes = 0;
  await page.route('**/api/clientRuntime/resourceCommand', async route => {
    const body = route.request().postDataJSON();
    if (body.payload?.args?.request?.operation?.kind !== 'saveMarkdown') return route.continue();
    writes++;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort('failed'); // Real file commit, then response loss.
  });
  await question.locator('button.quiz-option').first().click();
  await question.getByRole('button', { name: '重试保存', exact: true }).waitFor();
  assert.equal(writes, 1);
  await page.unroute('**/api/clientRuntime/resourceCommand');
  await question.getByRole('button', { name: '重试保存', exact: true }).click();
  await question.getByText('已记录到', { exact: false }).waitFor();
  const read = () => page.evaluate(async () => {
    const load = name => import(performance.getEntriesByType('resource').findLast(e => new URL(e.name).pathname === name)?.name ?? name);
    const { readWrongbook } = await load('/src/store/wrongbook.ts');
    const { parseWrongbook } = await load('/src/study/wrongbook.ts');
    const markdown = await readWrongbook();
    return { markdown, entries: parseWrongbook(markdown) };
  });
  const saved = await read();
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].attempts.length, 1, 'UI retry deduplicates the original attempt');
  assert.equal(writes, 1, 'unknown file result was not automatically replayed');
  await page.reload();
  await page.getByTestId('study-assistant-toggle').waitFor();
  if (await openAssistant.isVisible()) await openAssistant.click();
  await page.locator('.quiz-q').first().waitFor();
  assert.equal((await read()).markdown, saved.markdown);
  const record = await api.inject({ method: 'GET', url: '/api/v1/cloud/record?table=courseFiles&key=%22wrongbook.md%22', headers: { cookie } });
  assert.equal(record.json().value?.resourcePath, 'wrongbook.md', 'wrongbook is an actual resource file mapping');
  const actualFile = await api.inject({ method: 'GET', url: '/api/v1/resources/courses/wrongbook.md', headers: { cookie } });
  assert.equal(actualFile.statusCode, 200);
  assert.equal(actualFile.body, saved.markdown, 'the resource file, not a shadow record, is authoritative');
  // The normal cloud-library import keeps original bytes when the binary
  // installation succeeds but the browser never receives its acknowledgement.
  await page.goto(`${origin}/#/library`);
  await page.getByTestId('resource-list').waitFor();
  let uploads = 0, finishUpload;
  const uploaded = new Promise(resolve => { finishUpload = resolve; });
  await context.route(/\/api\/v1\/projects\/[^/]+\/uploads\?/, async route => {
    uploads++;
    const response = await route.fetch();
    assert.equal(response.status(), 201, await response.text());
    await route.abort('failed');
    finishUpload();
  });
  await page.locator('input[type="file"]').setInputFiles({ name: '领域导入.md', mimeType: 'text/markdown', buffer: Buffer.from('# 领域导入\n\n原始二进制字节。') });
  await uploaded;
  await page.getByTestId('resource-entry').filter({ hasText: '领域导入.md' }).waitFor();
  await page.reload();
  await page.getByTestId('resource-list').waitFor();
  const uploadDrafts = await page.evaluate(async () => {
    const name = '/src/store/db.ts';
    const { db } = await import(performance.getEntriesByType('resource').findLast(e => new URL(e.name).pathname === name)?.name ?? name);
    const drafts = (await db.table('_cloudMeta').toArray()).filter(row => row.id.startsWith('resource-command:') && row.value.request.operation.kind === 'upload');
    return Promise.all(drafts.map(async row => ({ operationId: row.value.request.operationId, state: row.value.state, text: await row.value.blob.text() })));
  });
  assert.equal(uploads, 1, 'reload never retransmits uncertain binary imports');
  assert.equal(uploadDrafts.length, 1);
  assert.equal(uploadDrafts[0].text, '# 领域导入\n\n原始二进制字节。');
  assert.equal(uploadDrafts[0].state, 'uncertain');
  await page.screenshot({ path: path.join(directory, 'wrongbook.png') });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ pass: true, writes, uploads, uploadDrafts, checks: ['real-quiz-ui', 'file-commit-response-lost', 'explicit-ui-retry', 'one-attempt', 'reload-file-authority', 'real-library-binary-import-response-lost', 'reload-no-retransmit-original-blob'] }, null, 2));
  console.log(`PASS: real cloud quiz → wrongbook file, lost response, explicit retry and reload (${directory})`);
} finally { await browser?.close(); await vite?.close(); await api.close(); }
