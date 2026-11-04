// Focused composer regression: deterministic upload gates, no real account or model.
// BASE_URL=http://localhost:5188 node scripts/e2e-attachment-upload-state.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let releaseUpload;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  if (process.env.SCREENSHOT_DIR) await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
  const screenshot = async name => {
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
  };
  page.on('pageerror', error => errors.push(error.message));
  let gate = new Promise(resolve => { releaseUpload = resolve; });
  let failImages = false;
  let uploads = 0;
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/files/config')) return route.fulfill({ json: { maxFileBytes: 20 * 1024 * 1024 } });
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { authenticated: true, user: { id: 'upload-test', name: 'Test' } } });
    if (route.request().method() === 'DELETE' && url.pathname.includes('/files/')) return route.fulfill({ json: { ok: true } });
    if (url.pathname.endsWith('/files') && route.request().method() === 'POST') {
      const name = decodeURIComponent(route.request().headers()['x-file-name']);
      uploads++;
      await gate;
      if (failImages && name.endsWith('.png')) return route.fulfill({ status: 500, json: { error: '图片上传失败，请重试' } });
      return route.fulfill({ status: 201, json: { id: `file-${uploads}`, originalName: name } });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(process.env.BASE_URL || 'http://localhost:5188');
  const input = page.locator('textarea.course-chat__input');
  await input.waitFor();
  const png = await page.evaluate(async () => {
    const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN');
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/src/store/courseChat.ts'));
    const { useCourseChat } = await import(moduleUrl || '/src/store/courseChat.ts'); window.__chat = useCourseChat;
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 100;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#79a8d1'; ctx.fillRect(0, 0, 240, 100);
    return canvas.toDataURL().split(',')[1];
  });
  await page.waitForFunction(() => window.__chat.getState().loaded);
  const image = { name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') };
  const draft = page.getByTestId('chat-attachment-draft');
  const card = draft.getByTestId('chat-attachment');
  const send = page.getByTestId('chat-send');
  const assertBlocked = async () => {
    assert.equal(await send.isDisabled(), true);
    await input.press('Enter');
    // Bypass the UI too: queue/steer must obey the same upload guard.
    await page.evaluate(async () => {
      for (const mode of [undefined, 'queue', 'steer']) await window.__chat.getState().send('blocked', mode);
    });
    const state = await page.evaluate(() => {
      const s = window.__chat.getState();
      return { activeId: s.activeId, messages: s.messages.length, queued: s.queued.length, draft: s.draft };
    });
    assert.deepEqual(state, { activeId: null, messages: 0, queued: 0, draft: '保留这段草稿' });
  };
  const assertFixedPreview = async () => {
    const size = await card.locator('img').evaluate(img => ({ width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height }));
    assert.deepEqual(size, { width: 78, height: 78 }); // 80px thumbnail minus its border
  };

  await page.getByTestId('chat-image-input').setInputFiles(image);
  await card.getByRole('status', { name: '图片上传中', exact: true }).waitFor();
  await input.fill('保留这段草稿');
  await assertBlocked();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await assertFixedPreview();
    await screenshot(`uploading-${width}`);
  }
  releaseUpload();
  await draft.locator('[data-state="ready"]').waitFor();
  assert.equal(await card.locator('.chat-image-pending__overlay').count(), 0);
  assert.equal(await draft.locator('.chat-attachments__error').count(), 0, 'the upload gate notice disappears when ready');
  assert.equal(await card.innerText(), '');
  assert.equal(await send.isEnabled(), true);
  await assertFixedPreview();
  await screenshot('ready-390');
  await input.focus(); await page.mouse.move(0, 0);
  const remove = card.getByRole('button', { name: '移除附件 preview.png', exact: true });
  assert.equal(await remove.evaluate(el => getComputedStyle(el).opacity), '0');
  await card.hover();
  assert.equal(await remove.evaluate(el => getComputedStyle(el).opacity), '1');
  await page.mouse.move(0, 0); await remove.focus();
  assert.equal(await remove.evaluate(el => getComputedStyle(el).opacity), '1', 'keyboard focus exposes removal');
  await remove.click();
  await card.waitFor({ state: 'detached' });

  // Failed images stay thumbnails, and one failure blocks an otherwise ready batch.
  gate = Promise.resolve(); failImages = true;
  await page.getByTestId('chat-file-input').setInputFiles([
    { name: 'ready.txt', mimeType: 'text/plain', buffer: Buffer.from('ready') }, image,
  ]);
  await draft.locator('[data-state="error"] img').waitFor();
  await draft.locator('[data-state="ready"]').waitFor();
  await assertBlocked();
  assert.equal(await draft.locator('.chat-image-draft').count(), 1);
  failImages = false;
  gate = new Promise(resolve => { releaseUpload = resolve; });
  await draft.getByRole('button', { name: '上传失败，重试', exact: true }).click();
  await draft.locator('.chat-image-draft[data-state="loading"]').waitFor();
  await assertBlocked();
  releaseUpload();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-attachment"][data-state="ready"]').length === 2);
  assert.equal(await send.isEnabled(), true);
  assert.equal(await draft.locator('.chat-image-pending__overlay').count(), 0);
  assert.equal(await draft.locator('.chat-attachments__error').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: upload/error/retry blocks click, Enter, queue and steer; fixed desktop/mobile previews; clean ready state; hover/focus removal.');
} finally {
  releaseUpload?.();
  await browser.close();
}
