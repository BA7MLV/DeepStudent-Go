// Progressive, script-free preview of show_widget HTML (P2).
// Requires `npm run dev`. Uses the real component; no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const shots = new URL('../e2e-shots/', import.meta.url);
await mkdir(shots, { recursive: true });
const refs = new URL('../packages/study-core/assets/builtin/interactive-explainer/references/', import.meta.url);
const example = (file) => fs.readFileSync(new URL(file, refs), 'utf8').match(/```html\n([\s\S]*?)\n```/)[1];
const examples = ['explore.md', 'stepper.md', 'simulation.md', 'manipulate.md', 'chart.md', 'practice.md'];

const browser = await (process.env.BROWSER === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome', headless: true }));
try {
  for (const width of [1280, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [], external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (!/^(data:|blob:|about:)/.test(request.url()) && !request.url().startsWith(BASE)) external.push(request.url()); });
    await page.goto(BASE);
    await page.evaluate(async () => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const client = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { createRoot } = client.default || client;
      const { default: Frame } = await import('/src/components/WidgetStreamFrame.tsx');
      const host = document.createElement('div');
      host.id = 'stream-frame-test';
      host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--background);padding:16px;z-index:99999';
      document.body.append(host);
      const root = createRoot(host);
      window.renderFrame = (html, dark = false) => root.render(React.createElement(Frame, { html, dark, status: '正在生成交互图形' }));
    });
    const flush = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const frame = page.locator('#stream-frame-test [data-testid="widget-stream-frame"]');
    const inner = () => frame.contentFrame();

    // 1. Styles, ids/classes and SVG survive; scripts, handlers and remote URLs do not.
    const hostile = `<style>#probe .box { color: rgb(1, 2, 3); background: url(https://evil.test/bg.png); }</style>
<section id="probe"><h3 class="box">标题</h3>
<svg viewBox="0 0 100 40" width="100" height="40"><rect data-r x="0" y="0" width="100" height="40" fill="var(--wbw-series-1)"/></svg>
<img src="https://evil.test/x.png" alt="外链"><img src="data:image/png;base64,iVBORw0KGgo=" alt="内联">
<a href="https://evil.test/">链接</a><button onclick="parent.__pwned = 1">按钮</button>
<input type="range" value="3" min="0" max="10"><output>3</output></section>
<script>parent.__pwned = 2</script><script>parent.__pwned = 3`;
    await page.evaluate((html) => window.renderFrame(html), hostile);
    await flush(); await flush();
    assert.equal(await frame.getAttribute('sandbox'), 'allow-same-origin', 'no allow-scripts');
    await inner().locator('#probe h3.box').waitFor();
    assert.equal(await inner().locator('#probe h3.box').evaluate((el) => getComputedStyle(el).color), 'rgb(1, 2, 3)', 'author CSS applies');
    assert.equal(await inner().locator('svg rect[data-r]').count(), 1, 'inline SVG kept');
    assert.equal(await inner().locator('script,[onclick],a[href^="http"],img[src^="http"]').count(), 0, 'no scripts, handlers or remote URLs');
    assert.equal(await inner().locator('img[src^="data:image/png"]').count(), 1, 'inline raster image kept');
    assert.equal(await inner().locator('body').evaluate((body) => body.inert), true, 'preview controls are inert');
    await inner().locator('button').click({ force: true, timeout: 2000 }).catch(() => {});
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'nothing executed');
    assert.equal(external.length, 0, `no network: ${external.join(', ')}`);
    assert.match(await page.locator('#stream-frame-test [role="status"]').textContent(), /正在生成交互图形/);

    // 2. Frozen top-level nodes stay mounted while the tail streams; height grows in flow.
    await page.evaluate(() => window.renderFrame('<p id="first">第一段</p><p>第二段'));
    await flush(); await flush();
    const before = (await frame.boundingBox()).height;
    await inner().locator('#first').evaluate((el) => { window.parent.__firstNode = el; });
    await page.evaluate(() => window.renderFrame('<p id="first">第一段</p>' + '<p>追加内容</p>'.repeat(60)));
    await flush(); await flush();
    assert.equal(await inner().locator('#first').evaluate((el) => window.parent.__firstNode === el), true, 'frozen node not re-created');
    assert.ok((await frame.boundingBox()).height > before + 200, 'frame grows with content');
    assert.ok(await inner().locator('html').evaluate((el) => el.scrollHeight <= el.clientHeight + 1), 'no nested scroll inside the preview');

    // 3. Theme tokens follow the host.
    await page.evaluate(() => window.renderFrame('<p id="theme">主题</p>', true));
    await flush();
    assert.equal(await inner().locator('html').getAttribute('data-wbw-theme'), 'dark');

    // 4. Every reference example: streamed prefix-by-prefix without errors, and the
    // complete markup (before its script runs) is already a sized, non-empty first frame.
    for (const file of examples) {
      const html = example(file);
      for (let end = 40; end < html.length; end += Math.ceil(html.length / 12)) {
        await page.evaluate((part) => window.renderFrame(part), html.slice(0, end));
        await flush();
      }
      await page.evaluate((part) => window.renderFrame(part), html);
      await flush(); await flush();
      const box = await frame.boundingBox();
      assert.ok(box.height >= 120, `${file}: first frame has real height (${box.height})`);
      assert.ok(box.width <= width, `${file}: fits ${width}px`);
      assert.equal(await inner().locator('script').count(), 0, `${file}: no script in preview`);
      for (const svg of await inner().locator('svg').all()) {
        const r = await svg.boundingBox();
        assert.ok(r && r.width > 40 && r.height > 40, `${file}: svg reserves its area before the script runs`);
      }
      await page.screenshot({ path: new URL(`stream-frame-${file.replace('.md', '')}-${width}.png`, shots).pathname });
    }
    assert.deepEqual(errors, [], errors.join('\n'));
    assert.equal(external.length, 0, `no network: ${external.join(', ')}`);
    await page.close();
  }
  console.log(`PASS (${process.env.BROWSER || 'chromium'}): script-free sandbox keeps author CSS/SVG, strips scripts/handlers/remote URLs, stays inert and offline, freezes completed nodes, grows in flow, follows theme, and all six reference examples stream into sized first frames at 1280/360px.`);
} finally {
  await browser.close();
}
