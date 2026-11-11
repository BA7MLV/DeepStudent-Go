// npx tsx scripts/e2e-chat-paste.mjs — isolated real API, never the user's backend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR, 'opencode', 'chat-paste-e2e-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const base = web.resolvedUrls.local[0].replace(/\/$/, '');
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
  const password = 'paste-fixture-password-123';
  assert.equal((await context.request.post(base + '/api/v1/bootstrap/initialize', { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  assert.equal((await context.request.post(base + '/api/v1/auth/password/login', { data: { password } })).status(), 200);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(`${base}/#/chat`);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  await page.evaluate(async () => { const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN'); });
  const input = page.locator('.course-chat__composer [contenteditable="true"][role="textbox"]');
  await input.waitFor();
  const paste = async (target, text) => {
    await page.evaluate((text) => navigator.clipboard.writeText(text), text);
    await target.focus();
    await target.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  };
  const draftItems = () => page.evaluate(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    return Promise.all(useChatAttachments.getState().items.map(async (item) => ({
      name: item.file.name, size: item.file.size, text: await item.file.text(), ready: !!item.value,
    })));
  });
  const clearAttachments = () => page.evaluate(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    const store = useChatAttachments.getState();
    await store.discard(Number(store.sessionKey));
  });

  for (const text of ['短文本', 'a'.repeat(4000), '🙂'.repeat(1000)]) {
    await input.fill('前后');
    await input.press('ArrowLeft');
    await paste(input, text);
    await page.waitForFunction((expected) => document.querySelector('.course-chat__composer [contenteditable="true"]').textContent === expected, `前${text}后`);
    assert.deepEqual(await draftItems(), []);
  }
  console.log('✓ Native short/exactly-4000-byte paste inserts at the caret');

  for (const text of ['a'.repeat(4001), '中'.repeat(1334), '🙂'.repeat(1001)]) {
    await input.fill('保留原草稿');
    await paste(input, text);
    await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
    assert.equal(await input.innerText(), '保留原草稿');
    const [item] = await draftItems();
    assert.match(item.name, /\.txt$/);
    assert.equal(item.size, Buffer.byteLength(text));
    assert.equal(item.text, text);
    assert.equal(await page.locator('[data-slot="toast"]').count(), 0, 'Successful conversion must not show a top toast');
    const card = page.getByTestId('chat-attachment');
    assert.ok((await card.boundingBox()).width <= 273, 'Text attachments stay compact');
    await card.getByRole('button', { name: `预览附件 ${item.name}`, exact: true }).click();
    const viewer = page.getByTestId('chat-document-preview');
    await viewer.waitFor();
    await page.waitForFunction(expected => document.querySelector('[data-testid="chat-document-preview"] pre')?.textContent === expected, text);
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'hidden' });
    await clearAttachments();
  }
  console.log('✓ ASCII/Chinese/emoji long pastes create full txt attachments and preserve the draft');

  const fullText = `正文开头\n${'超出模型摘要的正文。\n'.repeat(1800)}全文末尾 <script>window.__previewUnsafe = true</script>`;
  await paste(input, fullText);
  await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const trigger = page.getByTestId('chat-attachment').getByRole('button', { name: /^预览附件 / });
    await page.screenshot({ path: path.join(directory, `draft-${viewport.width}.png`) });
    await trigger.click();
    const viewer = page.getByTestId('chat-document-preview');
    await viewer.waitFor();
    await page.waitForFunction(expected => document.querySelector('[data-testid="chat-document-preview"] pre')?.textContent === expected, fullText);
    await viewer.evaluate(async el => { await Promise.allSettled(el.parentElement.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    const box = await viewer.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, JSON.stringify({ box, viewport }));
    assert.equal(await page.evaluate(() => window.__previewUnsafe), undefined, 'Preview renders text, never executable HTML');
    await page.screenshot({ path: path.join(directory, `preview-${viewport.width}.png`) });
    await viewer.getByRole('button', { name: '复制正文', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fullText);
    const download = page.waitForEvent('download');
    await viewer.getByRole('button', { name: '下载原文件', exact: true }).click();
    assert.match((await download).suggestedFilename(), /\.txt$/);
    await viewer.getByRole('button', { name: '关闭附件预览', exact: true }).click();
    await viewer.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('chat-document__open'));
  }
  await clearAttachments();
  await page.setViewportSize({ width: 1280, height: 900 });
  console.log('✓ Full original text (beyond 12,000 characters), safe text rendering, copy/download and mobile preview');

  await paste(input, '大文本预览\n'.repeat(40000));
  await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  await page.getByTestId('chat-attachment').getByRole('button', { name: /^预览附件 / }).click();
  await page.getByTestId('chat-document-preview').getByRole('status').getByText('仅预览部分正文，完整内容请下载原文件。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭附件预览', exact: true }).click();
  await clearAttachments();
  console.log('✓ Very large text previews are bounded and explicitly labeled');

  await input.fill('多行草稿\n'.repeat(40));
  await page.getByRole('button', { name: '展开输入框', exact: true }).click();
  const expanded = page.getByRole('textbox', { name: '完整消息', exact: true });
  await expanded.waitFor();
  const before = await expanded.innerText();
  await paste(expanded, '展开时粘贴'.repeat(500));
  await page.waitForFunction(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    return useChatAttachments.getState().items[0]?.value != null;
  });
  assert.equal(await expanded.innerText(), before);
  assert.equal((await draftItems())[0].text, '展开时粘贴'.repeat(500));
  await page.getByRole('button', { name: '收起输入框', exact: true }).click();
  await expanded.waitFor({ state: 'hidden' });
  await clearAttachments();
  console.log('✓ Expanded composer uses the same conversion');

  await input.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File(['file paste'], '原文件.txt', { type: 'text/plain' }));
    clipboardData.setData('text/plain', '中'.repeat(2000));
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  assert.equal((await draftItems())[0].name, '原文件.txt');
  assert.equal((await draftItems()).length, 1);
  await clearAttachments();
  console.log('✓ Clipboard files retain priority over accompanying text');

  await page.evaluate(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    useChatAttachments.getState().add(Array.from({ length: 8 }, (_, i) => new File(['full'], `full-${i}.txt`, { type: 'text/plain' })));
  });
  await page.waitForFunction(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    return useChatAttachments.getState().items.every((item) => item.value);
  });
  await input.fill('附件满时也保留草稿');
  await paste(input, 'a'.repeat(4001));
  await page.getByText('每条消息最多 8 个附件，请移除附件后重新粘贴', { exact: true }).waitFor();
  assert.equal(await input.innerText(), '附件满时也保留草稿');
  assert.equal((await draftItems()).length, 8);
  assert.deepEqual(errors, []);
  console.log('✓ Full attachment list reports an error without changing the draft; no page errors');
  console.log(`Screenshots: ${directory}`);
} finally {
  await browser.close();
  await web?.close();
  await app.close();
}
