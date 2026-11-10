/** Full Chat: real login, drag/drop, upload, task admission, native executor,
 * server history and reload. Only the provider HTTP response is scripted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'opencode', 'chat-attachments-e2e-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const bodies = [], errors = [];
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  assert.equal(new URL(String(url)).origin, 'https://attachment-model.invalid');
  const body = JSON.parse(init.body);
  bodies.push(body);
  const content = `已读取拖入的资料，第 ${bodies.length} 次回答。`;
  if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
} });
let web, browser, page, store, release;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false,
      proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const password = 'attachment-fixture-password-123';
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const config = new CloudConfiguration(store, directory), records = new CloudRecords(store);
  config.save(owner, { ...config.get(owner), providers: [{ id: 'fixture', name: 'Offline', protocol: 'openai-chat',
    baseUrl: 'https://attachment-model.invalid/v1', apiKey: 'fixture', serves: ['chat'], catalogId: '' }],
  llmModel: { providerId: 'fixture', model: 'fixture' } });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.route('**/chat/completions', route => { throw new Error('browser model call forbidden: ' + route.request().url()); });
  const gate = new Promise(resolve => { release = resolve; });
  let uploads = 0;
  await page.route('**/api/v1/files', async route => {
    if (route.request().method() === 'POST') { uploads++; await gate; }
    await route.continue();
  });
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  await page.evaluate(async () => { const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN'); });
  // Asymmetric pixels catch incorrect rotation/crop transforms, not just swapped
  // output dimensions. Exercise the real browser Canvas and file encoder.
  const rotationPixels = await page.evaluate(async () => {
    const { renderCropCanvas, exportCroppedImage, rotateCrop } = await import('/src/chat/cropImage.ts');
    const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 2;
    const context = canvas.getContext('2d');
    for (const [color, x, y] of [['red', 0, 0], ['lime', 2, 0], ['blue', 0, 1], ['yellow', 2, 1]]) {
      context.fillStyle = color; context.fillRect(x, y, 2, 1);
    }
    const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
    const full = { x: 0, y: 0, width: 100, height: 100 };
    const corners = output => {
      const ctx = output.getContext('2d'), w = output.width, h = output.height;
      return [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
    };
    const cw = renderCropCanvas(image, full, 1), ccw = renderCropCanvas(image, full, -1);
    const selected = rotateCrop({ x: 0, y: 0, width: 50, height: 100 }, 1);
    const file = await exportCroppedImage(image, selected, 'quadrants.png', false, 1);
    const output = await createImageBitmap(file);
    const cropped = document.createElement('canvas'); cropped.width = output.width; cropped.height = output.height;
    cropped.getContext('2d').drawImage(output, 0, 0); output.close();
    return { cw: corners(cw), ccw: corners(ccw), cropped: corners(cropped), dimensions: [cropped.width, cropped.height], type: file.type };
  });
  const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255], yellow = [255, 255, 0, 255];
  assert.deepEqual(rotationPixels, { cw: [blue, red, yellow, green], ccw: [green, yellow, red, blue],
    cropped: [blue, red, blue, red], dimensions: [2, 2], type: 'image/png' });
  const input = page.locator('.course-chat__composer [contenteditable="true"][role="textbox"]');
  await input.waitFor();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['DRAGGED_FILE_MARKER：原题第一题，选项 A B C D。'], '拖入的原题.txt', { type: 'text/plain' }));
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4180b0'; ctx.fillRect(0, 0, 80, 80);
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
    data.items.add(new File([bytes], '示意图.png', { type: 'image/png' }));
    document.querySelector('.course-chat__composer')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-attachment-draft"] [data-testid="chat-attachment"]').length === 2);
  await input.fill('分析拖入的文件和图片');
  const send = page.getByTestId('chat-send');
  assert.ok(await send.isDisabled());
  await input.press('Enter');
  assert.equal(bodies.length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM cloud_tasks WHERE kind='chat'").get().n, 0);
  release();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-attachment-draft"] [data-state="ready"]').length === 2);
  assert.equal(uploads, 2);
  // Optional crop: cancelling is non-destructive; keyboard resize uses original
  // pixels; a failed replacement keeps the original ready and the editor open.
  const cropButton = page.getByRole('button', { name: '裁切图片 示意图.png', exact: true });
  await cropButton.click();
  const cropDialog = page.getByTestId('image-crop-dialog');
  await cropDialog.getByText('输出 80 × 80 px。', { exact: false }).waitFor();
  await cropDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(uploads, 2, 'cancel never uploads or replaces');
  await cropButton.click();
  const rightHandle = cropDialog.getByRole('button', { name: '右边，使用方向键调整', exact: true });
  await rightHandle.focus();
  await rightHandle.press('Shift+ArrowLeft');
  await cropDialog.getByText('输出 70 × 80 px。', { exact: false }).waitFor();
  await cropDialog.getByRole('button', { name: '向右旋转', exact: true }).click();
  await cropDialog.getByText('输出 80 × 70 px。', { exact: false }).waitFor();
  await cropDialog.getByRole('button', { name: '向左旋转', exact: true }).click();
  await cropDialog.getByText('输出 70 × 80 px。', { exact: false }).waitFor();
  await cropDialog.getByRole('button', { name: '向右旋转', exact: true }).click();
  let failCrop = true;
  const rejectCrop = async route => {
    if (route.request().method() === 'POST' && failCrop) {
      failCrop = false;
      await route.fulfill({ status: 500, json: { error: 'crop_upload_fixture_failed' } });
    } else await route.fallback();
  };
  await page.route('**/api/v1/files', rejectCrop);
  await cropDialog.getByRole('button', { name: '保存裁切', exact: true }).click();
  await cropDialog.getByRole('alert').waitFor();
  assert.equal(await page.locator('[data-testid="chat-attachment-draft"] [data-state="ready"]').count(), 2);
  await page.unroute('**/api/v1/files', rejectCrop);
  await cropDialog.getByRole('checkbox', { name: '压缩大图', exact: true }).uncheck();
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await cropDialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, 'crop editor fits a mobile viewport');
  await page.screenshot({ path: path.join(directory, 'crop-mobile.png') });
  await cropDialog.getByRole('button', { name: '保存裁切', exact: true }).click();
  await cropDialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-attachment-draft"] [data-state="ready"]').length === 2);
  assert.equal(uploads, 3);
  await page.setViewportSize({ width: 1280, height: 900 });
  await send.click();
  const until = async predicate => { const deadline = Date.now() + 30000; while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } throw new Error('attachment_e2e_timeout'); };
  const latest = () => store.db.prepare("SELECT * FROM cloud_tasks WHERE kind='chat' ORDER BY created_at DESC LIMIT 1").get();
  await until(() => latest()?.status === 'completed' || latest()?.status === 'failed');
  assert.equal(latest().status, 'completed', latest().error);
  const result = JSON.parse(latest().result), taskInput = JSON.parse(latest().input);
  const row = records.get(owner, 'chats', result.userRowId);
  assert.equal(row.attachments.length, 2);
  assert.ok(row.attachments.every(file => file.serverId));
  const cropped = row.attachments.find(file => file.dataUrl);
  assert.match(cropped.name, /_裁切_.*\.png$/);
  const croppedBytes = await (await context.request.get(`${origin}/api/v1/files/${cropped.serverId}`)).body();
  const cropMetadata = await sharp(croppedBytes).metadata();
  assert.equal(cropMetadata.width, 80); assert.equal(cropMetadata.height, 70);
  assert.ok(JSON.stringify(bodies[0].messages).includes('DRAGGED_FILE_MARKER'));
  assert.ok(bodies[0].messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
  await page.getByText('已读取拖入的资料，第 1 次回答。', { exact: false }).first().waitFor();
  await page.reload();
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  await page.getByText('已读取拖入的资料，第 1 次回答。', { exact: false }).first().waitFor({ timeout: 30000 });
  await page.getByTestId('chat-message-attachments').waitFor();
  const thumbnail = page.getByTestId('chat-message-attachments').locator('.chat-image');
  const thumbnailBox = await thumbnail.boundingBox();
  assert.ok(thumbnailBox.width <= 97 && thumbnailBox.height <= 97, 'sent user photos stay thumbnail-sized');
  await thumbnail.click();
  await page.getByTestId('chat-image-viewer').waitFor();
  await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  await input.fill('接着分析刚才附件里的原题');
  await input.press('Enter');
  await until(() => bodies.length === 2 && latest()?.status === 'completed');
  assert.ok(JSON.stringify(bodies[1].messages).includes('DRAGGED_FILE_MARKER'));
  assert.ok(JSON.stringify(bodies[1].messages).includes(row.attachments.find(file => file.dataUrl).dataUrl));
  assert.equal(JSON.parse(latest().input).sessionId, taskInput.sessionId);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(directory, 'attachment-chat.png'), fullPage: true });
  console.log(`PASS real Chat drag/drop + upload blocking + multimodal model input + server persistence + reload + follow-up: ${directory}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true });
  throw error;
} finally {
  release?.();
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ modelCalls: bodies.length, errors }, null, 2));
  await browser?.close(); await web?.close(); await app.close(); store?.close();
}
