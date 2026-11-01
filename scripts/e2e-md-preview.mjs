import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const id = 'e2e-md-preview';
const fixture = [
  '# Markdown 完整预览',
  '',
  '**加粗内容**与[示例链接](https://example.com)。',
  '',
  '| 名称 | 数量 |',
  '| --- | --- |',
  '| 测试项 | 2 |',
  '',
  '- 列表第一项',
  '- 列表第二项',
  '',
  '```js',
  'const value = 42;',
  '```',
  '',
  '公式：$x^2 + y^2 = z^2$。',
  '',
  ...Array.from({ length: 60 }, (_, index) => `## 滚动章节 ${index + 1}\n\n这是一段用于验证滚动范围、位置和完整预览的长文内容。\n`),
].join('\n');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(BASE);
  await page.evaluate(async ({ id, fixture }) => {
    const { db } = await import('/src/store/db.ts');
    const { saveMaterialFile } = await import('/src/store/fileStore.ts');
    const blob = new Blob([fixture], { type: 'text/markdown' });
    await db.videos.put({ id, name: 'Markdown 预览测试.md', kind: 'material', materialFormat: 'md',
      size: blob.size, mimeType: blob.type, duration: 0, createdAt: Date.now(), status: 'new' });
    await saveMaterialFile(id, blob);
    location.hash = `/player/${id}`;
  }, { id, fixture });

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const source = page.locator('[data-testid="md-editor"] .cm-content');
  const scroller = page.locator('[data-testid="md-editor"] .cm-scroller');
  const modes = page.getByTestId('md-source-view');
  const preview = page.getByTestId('md-rendered-preview');
  const progress = page.getByRole('progressbar', { name: '文档滚动进度' });
  const switchMode = (name) => modes.getByRole('radio', { name, exact: true }).click();

  await source.waitFor();
  await switchMode('源码');
  await source.focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n\nPREVIEW_DRAFT_MARKER');
  await switchMode('预览');
  await preview.waitFor();
  assert.equal(await preview.locator('h1').textContent(), 'Markdown 完整预览');
  assert.equal(await preview.locator('strong').first().textContent(), '加粗内容');
  assert.equal(await preview.locator('table tbody tr').count(), 1);
  assert.equal(await preview.locator('li').count(), 2);
  assert.equal(await preview.locator('a[href="https://example.com"]').count(), 1);
  assert.ok((await preview.textContent()).includes('const value = 42;'));
  await preview.locator('.katex').waitFor();
  assert.ok((await preview.textContent()).includes('PREVIEW_DRAFT_MARKER'), 'preview must use the current unsaved draft');
  assert.equal(await source.isVisible(), false);
  assert.equal(await page.getByTestId('md-format-bar').isVisible(), false);
  if (process.env.PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.PREVIEW_SCREENSHOT });

  // A real wheel gesture must move the content and update the persistent progress indicator.
  await preview.hover();
  await page.mouse.wheel(0, 1000);
  await page.waitForFunction(() => document.querySelector('[data-testid="md-rendered-preview"]').scrollTop > 0);
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="文档滚动进度"]').getAttribute('aria-valuenow')) > 0);
  assert.ok(Number(await progress.getAttribute('aria-valuenow')) < 100);
  const gutter = await preview.evaluate((element) => element.offsetWidth - element.clientWidth);
  assert.ok(gutter >= 10, `scrollbar must reserve visible space: ${gutter}px`);
  await preview.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('[aria-label="文档滚动进度"]').getAttribute('aria-valuenow') === '100');
  assert.ok((await page.getByTestId('md-scroll-status').textContent()).includes('已到底部'));

  await switchMode('源码');
  await source.waitFor({ state: 'visible' });
  assert.ok(await scroller.evaluate((element) => element.scrollTop > 0), 'switching preview must retain the editor scroll position');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await switchMode('预览');
  assert.ok(!(await preview.textContent()).includes('PREVIEW_DRAFT_MARKER'), 'preview must retain the editor undo history');
  await switchMode('实时编辑');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await switchMode('预览');
  assert.ok((await preview.textContent()).includes('PREVIEW_DRAFT_MARKER'));

  const agentEdit = await page.evaluate(async (id) => {
    const { getMdEditor } = await import('/src/md-editor/bridge.ts');
    return getMdEditor(id)?.applyEdits([{ old_string: '**加粗内容**', new_string: '**预览期间更新**' }]);
  }, id);
  assert.equal(agentEdit?.ok, true, 'preview must keep the agent bridge registered');
  await page.waitForFunction(() => document.querySelector('[data-testid="md-rendered-preview"] strong')?.textContent === '预览期间更新');
  await page.getByTestId('md-agent-undo').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="md-rendered-preview"] strong')?.textContent === '加粗内容');

  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.ok(widths.page <= widths.viewport, `${colorScheme}: ${JSON.stringify(widths)}`);
      assert.ok(await modes.getByRole('radio', { name: '预览', exact: true }).isVisible());
      assert.ok(await progress.isVisible());
    }
  }
  if (process.env.PREVIEW_SCREENSHOT) {
    await page.screenshot({ path: process.env.PREVIEW_SCREENSHOT.replace(/\.png$/, '-mobile.png') });
  }

  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).waitFor();
  const saved = await page.evaluate(async (id) => {
    const { getMaterialFile } = await import('/src/store/fileStore.ts');
    return (await getMaterialFile(id)).text();
  }, id);
  assert.ok(saved.includes('PREVIEW_DRAFT_MARKER'), 'finishing from preview must save the draft');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await source.waitFor();
  await switchMode('源码');
  await source.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await switchMode('预览');
  assert.ok((await preview.textContent()).includes('暂无内容'));
  await page.waitForFunction(() => document.querySelector('[data-testid="md-scroll-status"]').textContent.includes('已显示全部'));
  assert.deepEqual(errors, []);
  console.log('✓ Markdown preview: rich rendering, current draft, wheel/progress, visible scrollbar, undo/redo, agent edits, mobile themes, save, empty state');
} finally {
  await browser.close();
}
