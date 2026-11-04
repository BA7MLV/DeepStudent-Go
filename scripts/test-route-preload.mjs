import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const web = await createServer({ root: 'apps/web', server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'route-preload-fixture',
  configureServer(server) {
    server.middlewares.use('/__route-preload', (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<a id="library" href="#/library/folders/demo"><span>Library</span></a>
        <a id="player" href="#/player/demo">Player</a><a id="foreign" href="https://example.invalid/#/library">Foreign</a>
        <script type="module">
        import {preloadOnIntent} from '/src/utils/preload.ts';
        window.calls=[];
        window.install=()=>preloadOnIntent({'/library':async()=>{calls.push('library')},'/player':async()=>{calls.push('player')}});
        window.stop=install(); document.body.dataset.ready='true';
        </script>`);
    });
  },
}] });
let browser;
try {
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${web.httpServer.address().port}/__route-preload`);
  await page.locator('body[data-ready="true"]').waitFor();
  assert.deepEqual(await page.evaluate(() => calls), [], 'no speculative reader/decoder imports at boot');
  await page.locator('#foreign').hover();
  assert.deepEqual(await page.evaluate(() => calls), [], 'foreign destinations do not trigger local preloads');
  await page.locator('#library span').hover();
  await page.locator('#library').focus();
  assert.deepEqual(await page.evaluate(() => calls), ['library'], 'nested pointer and keyboard intent share one preload');
  await page.locator('#player').focus();
  assert.deepEqual(await page.evaluate(() => calls), ['library', 'player']);
  await page.evaluate(() => { stop(); calls.length=0; });
  await page.locator('#library').focus();
  assert.deepEqual(await page.evaluate(() => calls), [], 'cleanup removes listeners');
  await page.evaluate(() => { Object.defineProperty(navigator, 'connection', { configurable:true, value:{saveData:true} }); window.stop=install(); });
  await page.locator('#player').focus();
  assert.deepEqual(await page.evaluate(() => calls), [], 'save-data disables intent prefetch');
  await page.evaluate(() => stop());
  console.log('PASS: route intent prefetch, deduplication, cleanup and save-data without idle speculative imports');
} finally { await browser?.close(); await web.close(); }
