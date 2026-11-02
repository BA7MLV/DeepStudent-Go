import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const byId = (id) => page.getByTestId(id);

// Real mouse input: Selection API alone bypasses the pan handler and user-select CSS.
async function dragText(target, start = 1, end = 10) {
  await target.scrollIntoViewIfNeeded();
  const points = await target.evaluate((el, { start, end }) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const runs = [];
    let node, length = 0;
    while ((node = walker.nextNode())) {
      runs.push({ node, start: length });
      length += node.length;
    }
    const range = document.createRange();
    const at = (offset, last) => {
      const run = runs.find(run => offset >= run.start && offset < run.start + run.node.length);
      range.setStart(run.node, offset - run.start); range.setEnd(run.node, offset - run.start + 1);
      const r = range.getBoundingClientRect();
      return { x: last ? r.right - 0.2 : r.left + 0.2, y: r.top + r.height / 2 };
    };
    return { a: at(start, false), b: at(end - 1, true), text: el.textContent.slice(start, end) };
  }, { start, end });
  await page.mouse.move(points.a.x, points.a.y);
  await page.mouse.down();
  await page.mouse.move(points.b.x, points.b.y, { steps: 10 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => getSelection()?.toString()), points.text);
  return points.text;
}

try {
  await page.goto(`${base}/#/library`);
  await page.locator('input[type=file]').setInputFiles({
    name: '当前编辑.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# 当前编辑\n\n' + Array.from({ length: 40 }, (_, i) => `第${i + 1}段：滑动选择文字应当正常工作，松手后可以标记或提问。`).join('\n\n')),
  });
  const item = byId('video-item').filter({ hasText: '当前编辑' });
  await item.waitFor();
  await page.goto(`${base}/#/player/${await item.getAttribute('data-video-id')}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="ink-read"]')?.disabled === false);
  assert.equal(await byId('ink-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await byId('ink-read').getAttribute('aria-checked'), 'true');
  const para = page.locator('.mr-md__block p').filter({ hasText: '第1段：' }).first();
  await dragText(para);
  await byId('selection-menu').waitFor();
  await byId('selection-mark').click();
  await page.locator('[data-ink-stroke]').waitFor();

  const later = page.locator('.mr-md__block p').nth(35);
  await dragText(later);
  assert.ok(await page.locator('.mr-scroll').evaluate(el => el.scrollTop) > 0);
  await byId('selection-menu').waitFor();
  await page.keyboard.press('Escape');

  await byId('ink-toggle').click();
  await byId('ink-pan').click();
  const bounds = await page.locator('.mr-scroll').boundingBox();
  const before = await page.locator('.mr-scroll').evaluate(el => el.scrollTop);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 - 80, { steps: 10 });
  await page.mouse.up();
  assert.ok(await page.locator('.mr-scroll').evaluate(el => el.scrollTop) > before);
  assert.equal(await page.evaluate(() => getSelection()?.toString()), '');
  await byId('ink-toggle').click();
  assert.equal(await byId('ink-read').getAttribute('aria-checked'), 'true');
  await dragText(para);
  await byId('selection-menu').waitFor();
  await page.keyboard.press('Escape');

  await byId('ink-toggle').click();
  await byId('ink-text-highlight').click();
  const textBounds = await para.boundingBox();
  await page.mouse.move(textBounds.x + 10, textBounds.y + textBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(textBounds.x + 150, textBounds.y + textBounds.height / 2, { steps: 10 });
  await page.mouse.up();
  assert.equal(await byId('ink-read').getAttribute('aria-checked'), 'true');
  await byId('ink-toggle').click();
  await dragText(para);
  await byId('selection-menu').waitFor();
  await page.keyboard.press('Escape');

  // Enter from explicit pan mode: neither editor nor full preview should inherit it.
  await byId('ink-toggle').click();
  await byId('ink-pan').click();
  await byId('md-edit-toggle').click();
  await page.locator('.cm-editor').waitFor();
  await dragText(page.locator('.cm-line').filter({ hasText: '第1段：' }).first());
  await page.getByRole('radio', { name: '源码', exact: true }).click();
  await dragText(page.locator('.cm-line').filter({ hasText: '第1段：' }).first());
  await page.getByRole('radio', { name: '预览', exact: true }).click();
  await dragText(byId('md-rendered-preview').locator('p').filter({ hasText: '第1段：' }).first());
  await byId('md-edit-toggle').click();
  await para.waitFor();
  await dragText(para);
  await byId('selection-menu').waitFor();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-testid="ink-read"]')?.disabled === false);
  await dragText(para);
  await byId('selection-menu').waitFor();
  console.log('PASS: Markdown default drag selection, marking, later paragraphs, explicit panning, collapsed tools, live/source/preview, edit exit and reload.');
} finally {
  await browser.close();
}
