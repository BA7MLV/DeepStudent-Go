import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const output = process.env.SHOTS || 'test-results/composer-expand';
const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'composer-expand-vite-'));
let web, browser;
try {
  await mkdir(output, { recursive: true });
  web = await createServer({
    root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await web.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(`http://127.0.0.1:${web.httpServer.address().port}`);
  await page.evaluate(async () => {
    const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN');
  });
  const input = page.locator('textarea.course-chat__input');
  const trigger = page.getByTestId('composer-expand');
  const dialog = page.getByTestId('composer-sheet');
  const editor = dialog.getByRole('textbox', { name: '完整消息', exact: true });
  await input.waitFor();
  const draft = '请帮我整理这节课的重点，并保留以下问题：\n\n' + '这是一段较长的消息，用于检查完整消息编辑器的布局和滚动。\n'.repeat(30);

  for (const viewport of [
    { width: 1440, height: 900 }, { width: 820, height: 680 },
    { width: 1440, height: 420 }, { width: 390, height: 844 }, { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await input.fill(draft);
    await trigger.click();
    await editor.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '完整消息');
    assert.equal(await editor.inputValue(), draft);
    await page.getByRole('dialog', { name: '编辑完整消息', exact: true }).waitFor();
    for (let index = 0; index < 4; index++) {
      await page.keyboard.press('Tab');
      assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)), 'keyboard focus stays inside the editor');
    }
    await dialog.getByRole('heading', { name: '编辑完整消息', exact: true }).waitFor();
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'editor fits viewport');
    if (viewport.width > 760) {
      assert.ok(box.width <= 720, 'desktop editor has a readable width');
      assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 1, 'desktop editor is horizontally centered');
      assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) < 1, 'desktop editor is vertically centered');
      assert.equal(await dialog.locator('.drawer__handle').count(), 0, 'desktop does not show a mobile grabber');
      assert.equal(await editor.evaluate(el => getComputedStyle(el).paddingTop), '16px', 'desktop input does not reserve a mobile overlay header');
    } else {
      assert.ok(Math.abs(box.width - viewport.width) < 1, 'mobile keeps its full-width sheet');
      assert.ok(Math.abs(box.y + box.height - viewport.height) < 1, 'mobile sheet is bottom attached');
    }
    const footer = await dialog.getByRole('button', { name: '完成', exact: true }).boundingBox();
    assert.ok(footer.y >= box.y && footer.y + footer.height <= box.y + box.height, 'Done remains visible with overflowing text');
    await editor.fill(`${draft}新增一行`);
    await editor.press('End');
    await editor.press('Enter');
    await editor.press('a');
    assert.ok((await editor.inputValue()).includes('\na'), 'Return inserts a newline instead of submitting');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      await page.screenshot({ path: path.join(output, `${viewport.width}x${viewport.height}-${theme}.png`), animations: 'disabled' });
    }
    const edited = await editor.inputValue();
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), edited, 'Done retains edits in the draft');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'composer-expand');
    await trigger.click();
    await editor.fill(`${edited}\n通过关闭操作保留草稿`);
    await dialog.getByRole('button', { name: '收起输入框', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.ok((await input.inputValue()).endsWith('通过关闭操作保留草稿'));
    await trigger.click();
    await editor.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok((await input.inputValue()).endsWith('通过关闭操作保留草稿'), 'Escape also retains the live draft');
  }

  // Resize an open editor across the breakpoint without losing the live draft.
  await page.setViewportSize({ width: 1440, height: 900 });
  await trigger.click();
  await editor.fill(draft);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.locator('.drawer__handle').waitFor();
  assert.equal(await editor.inputValue(), draft);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.composer-dialog').waitFor();
  assert.equal(await editor.inputValue(), draft);
  // Clearing a draft must not unmount the editor before the person can dismiss it.
  await editor.fill('');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await input.inputValue(), '');
  assert.deepEqual(errors, []);
  console.log(`Composer expand passed: desktop/mobile geometry, light/dark, draft retention, keyboard focus, newline, Escape and responsive resize. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await web?.close();
  await rm(cacheDir, { recursive: true, force: true });
}
