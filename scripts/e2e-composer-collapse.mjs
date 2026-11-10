// Real sends against an isolated API; the scripted model is held until the
// cleared composer has collapsed, so the test does not rely on a fast reply.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/composer-collapse-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
let releaseReply;
let replyStarted = Promise.withResolvers();
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (_url, init) => {
  await new Promise(resolve => { releaseReply = resolve; replyStarted.resolve(); });
  const body = JSON.parse(init.body), content = '已收到多行消息。';
  if (!body.stream) return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
} });
let web, browser;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  const password = 'composer-collapse-fixture-password';
  assert.equal((await post('/bootstrap/initialize', { adminPassword: password }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  assert.equal((await post('/auth/password/login', { password })).status(), 200);
  const config = await (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  assert.equal((await context.request.put(`${origin}/api/v1/cloud/config`, { headers: { origin }, data: { ...config,
    providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'test-only', serves: ['chat'] }],
    llmModel: { providerId: 'fixture', model: 'fixture' } } })).status(), 200);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByTestId('chat-add').waitFor({ timeout: 60000 });
  await page.evaluate(async () => { const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN'); });
  await page.evaluate(() => document.fonts.ready);
  const composer = page.locator('.course-chat__composer');
  const input = composer.locator('.cm-content');
  const expand = composer.getByTestId('composer-expand');
  const readDraft = () => page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().draft);
  const waitForEmpty = () => page.waitForFunction(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().draft === '');
  const finishReply = async () => {
    await replyStarted.promise;
    replyStarted = Promise.withResolvers();
    releaseReply(); releaseReply = undefined;
    await page.waitForFunction(async () => !(await import('/src/store/courseChat.ts')).useCourseChat.getState().loading);
  };
  const checkCompact = async () => {
    const [card, text, add, tools] = await Promise.all([composer.boundingBox(), input.boundingBox(), page.getByTestId('chat-add').boundingBox(), composer.locator('.course-chat__composer-tools').boundingBox()]);
    assert.ok(card.height <= 60, `cleared composer is a single row (${card.height}px)`);
    assert.ok(text.height < 45, 'placeholder does not wrap the empty editor');
    assert.ok(Math.abs(add.y + add.height / 2 - text.y - text.height / 2) < 8, 'add and input share a row');
    assert.ok(Math.abs(tools.y + tools.height / 2 - text.y - text.height / 2) < 8, 'send/stop controls share the input row');
    assert.ok(text.width >= 70, 'narrow screens retain usable typing space');
    assert.ok(card.x >= 0 && card.x + card.width <= page.viewportSize().width + 1, 'composer fits viewport');
    assert.equal(await expand.isHidden(), true, 'clearing the draft hides the expand control');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    return card.height;
  };

  // The welcome card retains the original text-above-tools layout.
  const welcomeText = await input.boundingBox(), welcomeAdd = await page.getByTestId('chat-add').boundingBox();
  assert.ok(welcomeText.y + welcomeText.height <= welcomeAdd.y + 1, 'welcome layout is unchanged');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await input.fill('第一行\n第二行\n第三行');
    assert.ok((await input.boundingBox()).height > 60, 'multiline draft grows');
    await input.press('Enter');
    await waitForEmpty();
    await page.locator('.course-chat:not(.course-chat--empty)').waitFor();
    await page.getByTestId('chat-stop').waitFor();
    await checkCompact();
    await page.screenshot({ path: path.join(directory, `sent-${width}.png`), animations: 'disabled' });
    await finishReply();
    const compactHeight = await checkCompact();
    await input.fill('短消息');
    assert.equal((await composer.boundingBox()).height, compactHeight, 'short drafts stay compact');
    await input.fill('这是一段需要保留的长消息。\n'.repeat(40));
    await expand.waitFor({ state: 'visible' });
    const longHeight = (await input.boundingBox()).height;
    assert.ok(longHeight > 60 && (await composer.boundingBox()).height <= 202, 'long drafts grow to the cap');
    await expand.click();
    const fullEditor = page.getByTestId('composer-sheet');
    await fullEditor.waitFor();
    await fullEditor.getByRole('button', { name: '完成', exact: true }).click();
    await fullEditor.waitFor({ state: 'detached' });
    assert.equal(await readDraft(), '这是一段需要保留的长消息。\n'.repeat(40), 'expanded editing preserves the draft');
    await input.press('Enter');
    await waitForEmpty();
    await page.getByTestId('chat-stop').waitFor();
    await checkCompact();
    await finishReply();
    console.log(`PASS ${width}px: send collapses before reply, compact controls, multiline growth and full editor`);
  }
  assert.deepEqual(errors, []);
  console.log(`Screenshots: ${directory}`);
} finally {
  releaseReply?.();
  await browser?.close();
  await web?.close();
  await app.close();
}
