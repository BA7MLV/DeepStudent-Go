// Real Web + API, isolated storage and deterministic model. No live IM account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { compactThreadTitle } from '../apps/web/src/pages/botMessages.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-composer-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = process.env.BOT_UI_REVIEW ? 46321 : reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://localhost:${port}`;
process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { BotApplicationService } = await import('../apps/api/src/agent/service.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const { StudyTools } = await import('../apps/api/src/agent/study.ts');
const modelInputs = [];
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (_url, init) => {
  modelInputs.push(JSON.parse(init.body));
  return Response.json({ choices: [{ message: { content: '附件已收到。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
} });
let browser, web, store;
const output = process.env.SCREENSHOT_DIR ?? path.join(directory, 'screenshots');
fs.mkdirSync(output, { recursive: true });
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { hmr: false, watch: null, host: 'localhost', port, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false, ws: true } } } });
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'composer-test-password-12345' }, { 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  assert.equal((await post('/auth/password/login', { password: 'composer-test-password-12345' })).status(), 200);
  const config = await (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  assert.equal((await context.request.put(`${origin}/api/v1/cloud/config`, { headers: { origin }, data: { ...config, providers: [{ id: 'offline', name: 'Offline', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'test', serves: ['chat'] }], llmModel: { providerId: 'offline', model: 'scripted' } } })).status(), 200);
  const thread = await (await post('/threads', { mode: 'bot', title: 'IM · 图片与输入框' })).json();
  const other = await (await post('/threads', { mode: 'bot', title: '另一段对话' })).json();
  const longThread = await (await post('/threads', { mode: 'bot', title: `IM · ${'0123456789abcdef'.repeat(4)}@im.wechat` })).json();
  const png = await sharp({ create: { width: 400, height: 220, channels: 3, background: '#79a8d1' } }).png().toBuffer();
  const file = await (await post('/files', png, { 'content-type': 'application/octet-stream', 'x-file-name': 'image.png', 'x-file-mime': 'image/png' })).json();
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const bot = new BotApplicationService(store, { enqueue() {} });
  for (let index = 0; index < 40; index++) bot.append(longThread.id, index % 2 ? 'assistant' : 'user', 'text', `渐进模糊滚动检查 ${index}：消息经过顶部时逐渐虚化，按钮保持清晰。`);
  bot.append(thread.id, 'user', 'text', `这张图\nAttachment fileId=${file.id}, name=image.png, mime=image/png. Use study_file to read/understand it.`);
  bot.append(thread.id, 'assistant', 'attachment', JSON.stringify({ fileId: file.id, name: 'image.png', mimeType: 'image/png', caption: '这是收到的图片。' }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/`);
  const open = async id => {
    const title = compactThreadTitle([thread, other, longThread].find(item => item.id === id).title);
    await page.evaluate(async () => {
      const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN');
      const { useBotPanel } = await import('/src/store/botPanel.ts'); useBotPanel.getState().setOpen(true);
    });
    await page.getByTestId('bot-panel-history').click();
    await page.getByRole('menu').getByText(title, { exact: true }).click();
    await page.getByTestId('bot-panel-history').filter({ hasText: title }).waitFor();
  };
  await open(thread.id);
  const panel = page.getByTestId('bot-panel');
  const input = panel.locator('textarea');
  await input.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="bot-message-attachments"] img')].length === 2 && [...document.querySelectorAll('[data-testid="bot-message-attachments"] img')].every(img => img.naturalWidth > 0));
  assert.equal(await panel.getByText(/Attachment fileId=/).count(), 0);
  assert.equal(await panel.getByRole('button', { name: '预览图片 image.png' }).count(), 2);
  await panel.getByRole('button', { name: '预览图片 image.png' }).first().click();
  await page.getByTestId('bot-image-viewer').waitFor();
  await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();

  await panel.getByTestId('bot-add').click();
  await page.getByRole('menuitem', { name: '上传图片', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  const before = store.db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=? AND role=\'user\'').get(thread.id).n;
  let releaseDraftUpload;
  const draftUploadGate = new Promise(resolve => { releaseDraftUpload = resolve; });
  const holdDraftUpload = async route => {
    if (decodeURIComponent(route.request().headers()['x-file-name'] ?? '') === 'draft.png') await draftUploadGate;
    await route.continue();
  };
  await page.route('**/api/v1/files', holdDraftUpload);
  await panel.getByTestId('bot-image-input').setInputFiles([{ name: 'draft.png', mimeType: 'image/png', buffer: png }]);
  await panel.getByTestId('chat-attachment').waitFor();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=? AND role=\'user\'').get(thread.id).n, before, 'selection does not send');
  await panel.getByRole('status', { name: '图片上传中', exact: true }).waitFor();
  await input.fill('和图片一起发送');
  assert.equal(await panel.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
  await input.press('Enter');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id=? AND role='user'").get(thread.id).n, before, 'uploading attachments block keyboard sends');
  await open(other.id); await input.fill('另一段草稿');
  assert.equal(await panel.getByTestId('chat-attachment').count(), 0);
  await open(thread.id); await input.filter({ hasText: '' }).waitFor();
  assert.equal(await input.inputValue(), '和图片一起发送');
  assert.equal(await panel.getByTestId('chat-attachment').count(), 1, 'drafts are conversation-scoped');
  releaseDraftUpload();
  await panel.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  assert.equal(await panel.locator('.chat-image-pending__overlay').count(), 0, 'ready previews have no upload badge');
  await page.unroute('**/api/v1/files', holdDraftUpload);
  await input.press('Enter');
  await panel.locator('.bot-messages').getByText('附件已收到。', { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await panel.getByTestId('chat-attachment').count(), 0);
  const sent = store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND role='user' AND kind='attachment' ORDER BY seq DESC LIMIT 1").get(thread.id);
  assert.equal(JSON.parse(sent.content).caption, '和图片一起发送');
  assert.equal(JSON.parse(sent.content).attachments.length, 1);
  assert.ok(modelInputs.some(body => body.messages.some(message => message.role === 'user' && message.content.includes('Use study_file'))), 'file hints go only to the model');

  // Paste and drag/drop share the same pending attachment pipeline.
  await input.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, png.toString('base64'));
  await panel.getByTestId('chat-attachment').hover();
  await panel.getByRole('button', { name: '移除附件 pasted.png', exact: true }).click();
  await panel.locator('.study-composer').evaluate(element => {
    const data = new DataTransfer(); data.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await panel.getByRole('button', { name: '移除附件 notes.txt', exact: true }).waitFor();
  await input.fill('长消息\n'.repeat(40));
  await panel.getByTestId('composer-expand').click();
  await page.getByTestId('composer-sheet').waitFor();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await input.fill('');
  await panel.getByRole('button', { name: '移除附件 notes.txt', exact: true }).click();

  // Partial upload failures retain every draft, and successful blobs are reused on retry.
  const uploads = new Map(); let failUpload = true;
  await page.route('**/api/v1/files', async route => {
    const name = decodeURIComponent(route.request().headers()['x-file-name'] ?? '');
    uploads.set(name, (uploads.get(name) ?? 0) + 1);
    if (name === 'retry.txt' && failUpload) { failUpload = false; await route.fulfill({ status: 500, json: { error: 'test_upload_failure' } }); }
    else await route.continue();
  });
  await panel.getByTestId('bot-file-input').setInputFiles(['good.txt', 'retry.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
  await input.fill('两个附件');
  await input.press('Enter');
  await panel.locator('.chat-attachments__error').waitFor();
  assert.equal(await panel.getByTestId('chat-attachment').count(), 2);
  assert.equal(await input.inputValue(), '两个附件');
  assert.equal(await panel.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
  const failedCount = store.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id=? AND role='user'").get(thread.id).n;
  await input.press('Enter');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id=? AND role='user'").get(thread.id).n, failedCount, 'failed attachments block keyboard sends');
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="bot-panel"] [data-testid="chat-attachment"][data-state="ready"]').length === 2);
  const retryAccepted = page.waitForResponse(response => response.url().endsWith(`/threads/${thread.id}/messages`) && response.request().method() === 'POST');
  await input.press('Enter');
  assert.equal((await retryAccepted).status(), 201);
  await panel.getByTestId('chat-attachment').first().waitFor({ state: 'detached' });
  assert.equal(uploads.get('good.txt'), 1, 'successful file is not uploaded again');
  assert.equal(uploads.get('retry.txt'), 2);
  const batch = JSON.parse(store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND role='user' AND kind='attachment' ORDER BY seq DESC LIMIT 1").get(thread.id).content);
  assert.equal(batch.attachments.length, 2);
  assert.equal(batch.caption, '两个附件');
  await page.unroute('**/api/v1/files');

  const rejected = await post(`/threads/${thread.id}/messages`, { clientNonce: 'invalid-batch', kind: 'attachment', content: JSON.stringify({ attachments: [{ fileId: file.id }, { fileId: 'not-owned' }] }) });
  assert.equal(rejected.status(), 400, 'the HTTP boundary validates every file, not only the first');
  assert.equal(store.db.prepare("SELECT 1 FROM messages WHERE client_nonce='invalid-batch'").get(), undefined);

  await panel.getByTestId('bot-panel-new').click();
  const threadCount = store.db.prepare('SELECT COUNT(*) n FROM threads').get().n;
  await panel.getByTestId('bot-image-input').setInputFiles({ name: 'new-thread.png', mimeType: 'image/png', buffer: png });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM threads').get().n, threadCount, 'picking a file does not create a conversation');
  await input.fill('新会话图片');
  await panel.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  const created = page.waitForResponse(response => /\/threads\/[^/]+\/messages$/.test(response.url()) && response.request().method() === 'POST');
  await input.press('Enter');
  const createdMessage = await (await created).json();
  assert.equal(createdMessage.kind, 'attachment');
  assert.equal(JSON.parse(createdMessage.content).caption, '新会话图片');
  await panel.getByTestId('chat-attachment').first().waitFor({ state: 'detached' });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM threads').get().n, threadCount + 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs WHERE trigger_message_id=?').get(createdMessage.id).n, 1);
  await page.getByText('操作失败，请重试。', { exact: true }).waitFor({ state: 'hidden', timeout: 12000 });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(thread.id);
    await panel.getByTestId('bot-image-input').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: png });
    await input.fill('这张图片讲述了什么内容？');
    await panel.getByTestId('chat-attachment').waitFor();
    await page.screenshot({ path: path.join(output, `bot-composer-${width}.png`), fullPage: true, animations: 'disabled' });
    const card = await panel.locator('.study-composer').boundingBox();
    assert.ok(card.x >= 0 && card.x + card.width <= width + 1, `composer fits ${width}px viewport`);
    assert.ok(card.y + card.height <= 901, 'composer stays above the viewport bottom');
    await panel.getByTestId('chat-attachment').hover();
    await panel.getByRole('button', { name: '移除附件 preview.png', exact: true }).click();
    await input.fill('');
  }
  const albumFiles = [];
  for (const name of ['first.png', 'second.png', 'fourth.png', 'fifth.png', 'notes.txt', 'third.png']) {
    const image = name.endsWith('.png');
    const palette = [['#aacdd1', '#7e9d8d', '#456e63'], ['#c5dce4', '#7a9495', '#557879'], ['#e8c6b7', '#b67f6a', '#855f57']][albumFiles.length % 3];
    const picture = image ? await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="${palette[0]}"/><circle cx="310" cy="64" r="36" fill="#fff1c8"/><path d="M0 220L112 92L248 220L324 138L400 206V300H0" fill="${palette[1]}"/><path d="M0 264Q140 180 260 242T420 216V300H0" fill="${palette[2]}"/></svg>`)).png().toBuffer() : Buffer.from('独立文件中断图片分组。');
    const response = await post('/files', picture, { 'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-mime': image ? 'image/png' : 'text/plain' });
    assert.equal(response.status(), 201);
    albumFiles.push(await response.json());
  }
  const owner = store.db.prepare('SELECT owner_id FROM threads WHERE id=?').get(other.id).owner_id;
  const study = new StudyTools(store, new CloudConfiguration(store, path.join(directory, 'config')), process.env.FILES_DIR);
  const sendFile = study.plugins.get('study_send_file');
  const deliveryContext = { owner, thread: other.id, run: '', step: '', signal: new AbortController().signal, checkActive() {},
    append: (kind, content) => bot.append(other.id, 'assistant', kind, content) };
  await sendFile.execute({ fileIds: albumFiles.map(file => file.id), caption: '批量发送的图片可以叠放翻看。' }, deliveryContext);
  await sendFile.execute({ fileIds: albumFiles.slice(0, 2).map(file => file.id) }, deliveryContext);
  for (const file of albumFiles.slice(0, 2)) await sendFile.execute({ fileId: file.id, caption: '单张发送保持独立。' }, deliveryContext);
  await open(other.id);
  const album = panel.getByRole('button', { name: '查看 4 张图片', exact: true });
  await album.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.chat-image-stack[data-count="4"] img')].length === 3 && [...document.querySelectorAll('.chat-image-stack img')].every(img => img.naturalWidth > 0));
  assert.equal(await panel.locator('.chat-image-stack').count(), 2, 'a file breaks consecutive image grouping; separate batches remain separate');
  assert.equal(await panel.locator('.chat-image-stack[data-count="4"] img').count(), 3, 'large albums render at most three real image cards');
  assert.equal(await panel.locator('.chat-image-stack[data-count="2"] img').count(), 2, 'two images have exactly two cards');
  assert.equal(await panel.locator('.chat-image-stack[data-count="4"] .chat-image-stack__count').innerText(), '4');
  assert.equal(await panel.locator('.chat-image-stack[data-count="4"] button').count(), 1, 'back cards add no duplicate interactive controls');
  assert.equal(await panel.locator('.chat-image-stack__card:not([aria-hidden="true"])').count(), 0, 'back cards are decorative to assistive technology');
  assert.equal(await panel.locator('.chat-image-gallery[data-count="1"]').count(), 3, 'two independent sends never merge into the batch or one another');
  await panel.getByRole('button', { name: '预览图片 third.png', exact: true }).waitFor();
  await album.click();
  const viewer = page.getByTestId('bot-image-viewer');
  await viewer.getByRole('heading', { name: 'first.png', exact: true }).waitFor();
  assert.equal(await viewer.getByRole('button', { name: '上一张图片', exact: true }).isDisabled(), true);
  await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
  await viewer.getByRole('heading', { name: 'second.png', exact: true }).waitFor();
  await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
  await viewer.getByRole('heading', { name: 'fourth.png', exact: true }).waitFor();
  await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
  await viewer.getByRole('heading', { name: 'fifth.png', exact: true }).waitFor();
  assert.equal(await viewer.getByRole('button', { name: '下一张图片', exact: true }).isDisabled(), true);
  await page.keyboard.press('ArrowLeft');
  await viewer.getByRole('heading', { name: 'fourth.png', exact: true }).waitFor();
  await viewer.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    // Trial clicks retry if the dynamic-height virtual row remounts on resize.
    await album.click({ trial: true });
    const stack = await panel.locator('.chat-image-stack[data-count="4"]').evaluate(element => {
      const parent = element.closest('.bot-message-attachments').getBoundingClientRect();
      return [...element.querySelectorAll('.chat-image-stack__card')].map(card => {
        const bounds = card.getBoundingClientRect();
        return { transform: getComputedStyle(card).transform, fits: bounds.left >= parent.left && bounds.right <= parent.right + 1 };
      });
    });
    assert.equal(stack.length, 2);
    assert.ok(stack.every(card => card.transform !== 'none' && card.fits), `rotated cards fit the message at ${width}px`);
    assert.notEqual(stack[0].transform, stack[1].transform, 'each card is offset and rotated independently');
    await page.screenshot({ path: path.join(output, `bot-image-stack-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.evaluate(async () => { const { applyTheme } = await import('/src/ui/theme.ts'); applyTheme('dark'); });
  await album.click({ trial: true });
  await page.screenshot({ path: path.join(output, 'bot-image-stack-dark.png'), fullPage: true, animations: 'disabled' });
  await page.evaluate(async () => { const { applyTheme } = await import('/src/ui/theme.ts'); applyTheme('light'); });
  // Long IM peer IDs must never cover actions, including around the drawer breakpoint.
  for (const width of [1440, 901, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await open(longThread.id);
    await panel.locator('[data-chat-positioned="true"]').waitFor();
    const geometry = await panel.evaluate(element => {
      const bar = element.querySelector('.bot-panel__bar');
      const title = element.querySelector('.bot-panel__switcher-name');
      const switcher = element.querySelector('.bot-panel__switcher');
      const actions = element.querySelector('.bot-panel__actions');
      const messages = element.querySelector('.bot-messages');
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return {
        bar: rect(bar), switcher: rect(switcher), actions: rect(actions), messages: rect(messages),
        titleText: title.textContent,
        fullTitle: title.title,
        padding: parseFloat(getComputedStyle(messages).paddingTop),
        layers: [...bar.querySelectorAll('.page-app-bar__blur > span')].map(span => getComputedStyle(span).backdropFilter),
      };
    });
    assert.equal(geometry.titleText, '012345…cdef', `IM peer is compact at ${width}px`);
    assert.equal(geometry.fullTitle, longThread.title, 'full title remains available on hover');
    assert.ok(geometry.switcher.right <= geometry.actions.left + 1, 'title never overlaps actions');
    assert.ok(geometry.actions.right <= geometry.bar.right, 'all action buttons stay inside header');
    assert.equal(Math.round(geometry.messages.top), Math.round(geometry.bar.top), 'messages scroll behind the header');
    assert.ok(geometry.padding >= geometry.bar.bottom - geometry.bar.top, 'first message clears the header');
    assert.equal(geometry.layers.length, 4, 'four progressive blur layers are present');
    const radii = geometry.layers.map(value => Number(/^blur\(([\d.]+)px\)$/.exec(value)?.[1]));
    assert.ok(radii.every((radius, index) => radius > (radii[index - 1] ?? 0)), 'blur layers increase in strength on desktop and mobile');
    await panel.locator('.bot-messages').evaluate(element => { element.scrollTop = 120; });
    await page.screenshot({ path: path.join(output, `bot-header-${width}.png`), animations: 'disabled' });
    await panel.getByTestId('bot-panel-more').click();
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape');
  }
  // Safari can resize AND pan the visual viewport without changing innerHeight.
  // Override its metrics, but keep the real event target used by mounted effects.
  await page.setViewportSize({ width: 390, height: 900 });
  await input.focus();
  const setVisualViewport = metrics => page.evaluate(metrics => {
    for (const [key, value] of Object.entries(metrics)) Object.defineProperty(window.visualViewport, key, { configurable: true, value });
    window.visualViewport.dispatchEvent(new Event('resize'));
    window.visualViewport.dispatchEvent(new Event('scroll'));
  }, metrics);
  for (const offsetTop of [0, 80, 160, 40]) {
    await setVisualViewport({ height: 480, offsetTop, scale: 1 });
    await page.waitForFunction(({ top, height }) => {
      const host = document.querySelector('.app-viewport').getBoundingClientRect();
      const drawer = document.querySelector('.app-aside-drawer').getBoundingClientRect();
      const composer = document.querySelector('[data-testid="bot-panel"] .imsg-composer').getBoundingClientRect();
      return Math.abs(host.top - top) < 1 && Math.abs(host.height - height) < 1
        && Math.abs(drawer.top - top) < 1 && Math.abs(composer.bottom - (top + height)) < 1;
    }, { top: offsetTop, height: 480 });
  }
  await page.screenshot({ path: path.join(output, 'bot-keyboard-panned.png'), animations: 'disabled' });
  await setVisualViewport({ height: 240, offsetTop: 100, scale: 2 });
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--vvh')), '480px', 'pinch zoom does not reflow the page');
  await input.blur();
  await setVisualViewport({ height: 900, offsetTop: 80, scale: 1 });
  assert.equal(await page.evaluate(() => document.querySelector('.app-viewport').getBoundingClientRect().top), 0, 'stale Safari offset is cleared when the keyboard closes');
  for (const height of [560, 900]) {
    await page.setViewportSize({ width: 390, height });
    await setVisualViewport({ height, offsetTop: 0, scale: 1 });
    await page.waitForFunction(height => Math.abs(document.querySelector('[data-testid="bot-panel"] .imsg-composer').getBoundingClientRect().bottom - height) < 1, height);
  }
  assert.deepEqual(errors, []);
  console.log(`Bot composer/header passed: image previews, draft isolation, send, paste/drop, expand, progressive blur and long IM titles at 1440/901/760/390/320px. Screenshots: ${output}`);
  if (process.env.BOT_UI_REVIEW) {
    console.log(`Review: ${origin} (isolated fixture; login password composer-test-password-12345)`);
    await new Promise(resolve => process.once('SIGTERM', resolve));
  }
} finally {
  await browser?.close(); await web?.close(); store?.close(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
