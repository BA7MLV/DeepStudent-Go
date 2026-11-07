/** Selected skills stay visible from draft to committed/reloaded messages.
 * Real API/SQLite and UI; only the model response is scripted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fixtureBrowserDomain } from './fixture-domain.mjs';

const temporary = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporary, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporary, 'skill-chips-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  assert.equal(new URL(String(url)).origin, 'https://model.invalid');
  const body = JSON.parse(init.body), content = '技能标签测试回答。';
  if (!body.stream) return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
} });
let web, browser, store, page;
const errors = [];
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false,
      proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' });
  const password = 'skill-chips-fixture-password';
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store), config = new CloudConfiguration(store, directory);
  config.save(owner, { ...config.get(owner), providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-chat',
    baseUrl: 'https://model.invalid/v1', apiKey: 'test-only', serves: ['chat'], catalogId: '' }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  await fixtureBrowserDomain(context.request, origin, 'setPreferences', { operationId: crypto.randomUUID(), changes: [{ key: 'uiLanguage', expected: null, value: 'zh-CN' }] });
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value }]);
  put('videos', 'chip-course', { id: 'chip-course', name: '技能标签课程', kind: 'material', materialFormat: 'md', createdAt: 1 });
  put('chatSessions', 900001, { id: 900001, videoId: 'chip-course', title: '课程标签', createdAt: 1 });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const open = async (panel = false) => {
    await page.getByTestId(panel ? 'panel-chat-add' : 'chat-add').click();
    assert.equal(await page.getByRole('menuitem', { name: '生成讲义', exact: true }).count(), 0);
    await page.getByRole('menuitem', { name: /技能/ }).click();
    await page.getByTestId('skill-scope-item').last().waitFor();
  };
  const choose = name => page.locator(`[data-testid="skill-scope-item"][data-skill-name="${name}"] .skill-picker__content`).click();
  const close = async () => {
    await page.getByTestId('skill-picker-done').click();
    await page.getByTestId('skill-picker-dialog').waitFor({ state: 'hidden' });
  };
  await page.goto(origin);
  await page.getByTestId('chat-add').waitFor({ timeout: 60000 });
  await open();
  await page.getByText('按需用静态配图或交互演示讲清楚：流程、关系、函数、调参、模拟与练习。', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-skill-name="讲解配图"], [data-skill-name="交互式讲解"]').count(), 0);
  assert.equal(await page.getByTestId('skill-scope-item').count(), 5);
  await choose('可视化讲解'); await choose('课程讲义'); await close();
  const draft = page.getByTestId('composer-skill-chips');
  await draft.getByText('可视化讲解', { exact: true }).waitFor();
  await draft.getByText('课程讲义', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-active-skills').count(), 0);
  await draft.getByRole('button', { name: '移除技能：课程讲义', exact: true }).click();
  assert.equal(await draft.getByTestId('skill-chip').count(), 1);
  const selectLegacy = () => page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    const visual = await db.skills.filter(skill => skill.name === '可视化讲解').first();
    useCourseChat.getState().setTurnSkillIds(visual.legacyIds);
  });
  await selectLegacy();
  await draft.getByText('可视化讲解', { exact: true }).waitFor();
  assert.equal(await draft.getByTestId('skill-chip').count(), 1, 'both old IDs render one chip');
  await draft.getByRole('button', { name: '移除技能：可视化讲解', exact: true }).click();
  await draft.waitFor({ state: 'hidden' });
  await selectLegacy();
  const input = page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true });
  await input.fill('用配图说明学习流程');
  await page.screenshot({ path: path.join(directory, 'desktop-draft.png') });
  await input.press('Enter');
  await page.getByTestId('message-skill-chips').getByText('可视化讲解', { exact: true }).waitFor();
  await page.getByText('技能标签测试回答。', { exact: true }).first().waitFor({ timeout: 60000 });
  await draft.waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByTestId('message-skill-chips').getByText('可视化讲解', { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByTestId('message-skill-chips').getByTestId('skill-chip').count(), 1);
  await open(); await choose('课程讲义'); await choose('可视化讲解'); await close();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 740 });
    await draft.getByText('课程讲义', { exact: true }).waitFor();
    const bounds = await draft.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'chips fit narrow screens');
    assert.equal(await page.locator('.course-chat__composer').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await page.screenshot({ path: path.join(directory, `mobile-${width}.png`) });
  }
  console.log('PASS: named/removable draft chips, send + reload persistence, handout skill entry, desktop and 320px/390px layout.');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/#/player/chip-course`);
  const toggle = page.getByTestId('study-assistant-toggle');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-label') === '打开学习助手') await toggle.click();
  await page.getByTestId('panel-tab-chat').click();
  await open(true); await choose('可视化讲解'); await close();
  await draft.getByText('可视化讲解', { exact: true }).waitFor();
  const panelInput = page.getByRole('textbox', { name: '给学习助手发送消息', exact: true });
  await panelInput.fill('演示参数变化'); await panelInput.press('Enter');
  await page.getByTestId('message-skill-chips').getByText('可视化讲解', { exact: true }).waitFor();
  await page.getByText('技能标签测试回答。', { exact: true }).first().waitFor({ timeout: 60000 });
  await page.reload();
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-label') === '打开学习助手') await toggle.click();
  await page.getByTestId('panel-tab-chat').click();
  await page.getByTestId('message-skill-chips').getByText('可视化讲解', { exact: true }).waitFor({ timeout: 60000 });
  await page.screenshot({ path: path.join(directory, 'panel-history.png') });
  assert.deepEqual(errors, []);
  console.log(`PASS: course panel selection, send and reload chips; no page errors. Screenshots: ${directory}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    console.error({ directory, errors, text: (await page.locator('body').innerText()).slice(-5000) });
  }
  throw error;
} finally {
  await browser?.close(); await web?.close(); await app.close(); store?.close();
}
