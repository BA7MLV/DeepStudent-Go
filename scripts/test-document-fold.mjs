// Standalone visual regression: no server, account, or library mutations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const css = (await Promise.all(['library', 'resources'].map(name =>
  readFile(new URL(`../apps/web/src/pages/${name}.css`, import.meta.url), 'utf8')))).join('\n');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 });
  const cover = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="74" height="96"><rect width="74" height="96" fill="white"/></svg>');
  for (const background of ['#eceef1', '#20242b', '#b4d6fb']) {
    for (const image of [false, true]) {
      for (const mode of ['grid', 'mobile', 'list', 'resource-list', 'drag']) {
        const wrapper = mode === 'list' ? 'finder-items--list' : mode === 'resource-list' ? 'resource-grid' : mode === 'drag' ? 'finder-drag-preview' : '';
        await page.setContent(`<style>${css}
          :root { --radius-xs: 4px; --surface: white; }
          body { margin: 0; background: ${background}; }
          #fixture { position: static; display: block; margin: 40px; padding: 0; opacity: 1; }
          #fixture.mobile .finder-document { width: 60px; height: 80px; }
          .badge { position: absolute; right: -7px; bottom: -5px; width: 14px; height: 14px; background: red; }
        </style><div id="fixture" class="${wrapper} ${mode}" data-view="list"><span class="resource-file-icon"><span class="finder-document">
          ${image ? `<img src="${cover}" alt="" />` : '<span class="finder-file-placeholder"><i></i><i></i></span>'}
          <span class="finder-file-extension">MD</span><span class="badge"></span>
        </span></span></div>`);
        await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
        const rect = await page.locator('.finder-document').boundingBox();
        const png = PNG.sync.read(await page.screenshot());
        const pixel = (x, y) => [...png.data.subarray((Math.floor(y) * png.width + Math.floor(x)) * 4, (Math.floor(y) * png.width + Math.floor(x)) * 4 + 3)];
        const expectedBackground = background.match(/\w\w/g).map(value => parseInt(value, 16));
        const folded = mode === 'grid' || mode === 'mobile';
        assert.deepEqual(pixel(rect.x + rect.width - 4, rect.y + 2), folded ? expectedBackground : [255, 255, 255], `${background}, image=${image}, ${mode}: corner`);
        assert.deepEqual(pixel(rect.x + 6, rect.y + rect.height - 8), [255, 255, 255], `${mode}: paper remains white`);
        assert.deepEqual(pixel(rect.x + rect.width + 2, rect.y + rect.height - 2), [255, 0, 0], `${mode}: badge is not clipped`);
      }
    }
  }
  console.log('PASS: 30 document variants; transparent fold, white paper, unclipped badge, and unfolded list/drag icons.');
} finally {
  await browser.close();
}
