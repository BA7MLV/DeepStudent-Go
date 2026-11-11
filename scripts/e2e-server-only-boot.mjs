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
  for (const scenario of ['login', 'setup', 'missing-api', 'static-status', 'unavailable', 'network-error']) {
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
    await page.route('**/api/v1/bootstrap/status', route => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ initialized: scenario !== 'setup', hasPasskey: false }) }));
    await page.route('**/api/v1/auth/session', route => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, user: null }) }));
    await page.route('**/api/v1/cloud/status', route => scenario === 'network-error' ? route.abort()
      : route.fulfill({ status: scenario === 'missing-api' ? 404 : scenario === 'unavailable' ? 503 : 200,
        contentType: 'application/json', body: JSON.stringify({ cloud: scenario === 'login' || scenario === 'setup' }) }));
    await page.goto(web.resolvedUrls.local[0]);
    await page.locator(`main.ob[data-step="${scenario === 'setup' ? 'welcome' : 'login'}"]`).waitFor();
    assert.deepEqual(appRequests, [], `${scenario} must not load the static application`);
    assert.deepEqual(historyRequests, [], `${scenario} must not load history export`);
    assert.equal(await page.evaluate(() => window.historyScans), 0, 'no startup database enumeration');
    assert.equal(await page.getByTestId('open-local-history').count(), 0, 'no unauthenticated history export entry');
    assert.equal(await page.getByTestId('local-history-export').count(), 0, 'no unauthenticated history export panel');
    assert.equal(await page.getByRole('button', { name: /导出|export/i }).count(), 0, 'no data export buttons before login');
    await page.close();
  }
  console.log('PASS server-only boot: login, setup and server failures expose no unauthenticated history export or database enumeration');
} finally { await browser?.close(); await web?.close(); }
