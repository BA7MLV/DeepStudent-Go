import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/server-only-boot-');
let web, browser;
try {
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'cache'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
  await web.listen();
  browser = await chromium.launch({ headless: true });
  for (const scenario of ['missing-api', 'static-status', 'unavailable', 'network-error']) {
    const page = await browser.newPage();
    const appRequests = [];
    const historyRequests = [];
    page.on('request', request => { if (/\/src\/App\.tsx(?:\?|$)/.test(request.url())) appRequests.push(request.url()); });
    page.on('request', request => { if (/\/src\/cloud\/(?:LocalHistoryExport|local-history-export)\./.test(request.url())) historyRequests.push(request.url()); });
    await page.addInitScript(() => {
      window.historyScans = 0;
      const databases = indexedDB.databases.bind(indexedDB);
      indexedDB.databases = () => { window.historyScans++; return databases(); };
    });
    await page.route('**/api/v1/cloud/status', route => scenario === 'network-error' ? route.abort()
      : route.fulfill({ status: scenario === 'missing-api' ? 404 : scenario === 'unavailable' ? 503 : 200,
        contentType: 'application/json', body: JSON.stringify({ cloud: false }) }));
    await page.goto(web.resolvedUrls.local[0]);
    await page.locator('input[type="password"]').waitFor();
    assert.deepEqual(appRequests, [], `${scenario} must not load the static application`);
    assert.deepEqual(historyRequests, [], `${scenario} must not eagerly load history export`);
    assert.equal(await page.evaluate(() => window.historyScans), 0, 'no startup database enumeration');
    await page.getByTestId('open-local-history').click();
    await page.getByTestId('local-history-export').waitFor();
    await page.waitForFunction(() => window.historyScans > 0);
    assert.ok(historyRequests.length > 0, 'explicit action loads the export tool');
    assert.deepEqual(appRequests, [], 'local export must not start the application');
    await page.close();
  }
  console.log('PASS server-only boot: missing API, cloud=false, 503 and network failure remain behind the account gate');
} finally { await browser?.close(); await web?.close(); }
