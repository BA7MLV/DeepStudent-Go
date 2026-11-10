/** Read-only browser transport diagnostic. No app credentials or business data. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { webkit, chromium } from 'playwright';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/navigation-errors-');
const evidence = { browser: process.env.BROWSER ?? 'webkit', abortOnHide: !!process.env.ABORT_ON_HIDE, rounds: 20, errors: [], failures: [], caught: 0, unhandled: [] };
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(`<script>
      window.unhandled=[];window.caught=0;window.calls=0;
      const lifetime = new AbortController();
      ${evidence.abortOnHide ? "addEventListener('pagehide',()=>{clearInterval(window.timer);lifetime.abort();});" : ''}
      addEventListener('unhandledrejection',event=>window.unhandled.push(String(event.reason)));
      function run(){window.calls++;fetch('/api/read',{method:'POST',body:'read',signal:lifetime.signal}).then(r=>r.text()).catch(()=>window.caught++);fetch('/api/edit',{method:'POST',body:'edit',signal:lifetime.signal}).then(r=>r.text()).catch(()=>window.caught++);}
      window.timer=setInterval(run,10);run();
    </script>`);
  } else setTimeout(() => { if (!res.destroyed) res.end('OK'); }, 150);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const engine = evidence.browser === 'chromium' ? chromium : webkit;
const context = await engine.launchPersistentContext(path.join(directory, 'profile'), { headless: true });
try {
  await context.route('**/api/edit', route => route.abort('failed'));
  const page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push({ at: Date.now(), message: error.message, stack: error.stack }));
  page.on('requestfailed', request => evidence.failures.push({ at: Date.now(), url: request.url(), error: request.failure()?.errorText }));
  await page.goto(origin);
  for (let round = 0; round < evidence.rounds; round++) {
    await page.waitForFunction(() => window.calls >= 5);
    const state = await page.evaluate(() => ({ caught, unhandled }));
    evidence.caught += state.caught; evidence.unhandled.push(...state.unhandled);
    await page.reload();
  }
  await page.evaluate(() => clearInterval(window.timer));
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({ caught, unhandled }));
  evidence.caught += state.caught; evidence.unhandled.push(...state.unhandled);
  evidence.version = context.browser().version();
  console.log(`Navigation transport diagnostic: ${directory}; errors=${evidence.errors.length}, caught=${evidence.caught}, unhandled=${evidence.unhandled.length}`);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await context.close(); await new Promise(resolve => server.close(resolve));
}
