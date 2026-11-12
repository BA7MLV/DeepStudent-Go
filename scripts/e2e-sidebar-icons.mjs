import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Isolated authenticated app: never use the user's account or conversations.
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/sidebar-icons-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, page;
const errors = [];
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.5, `${message}: ${actual} ≠ ${expected}`);
const navIds = ['nav-rail-chat', 'nav-rail-home', 'nav-rail-bot'];

async function checkIconSizes() {
  for (const id of navIds) {
    const icon = await page.getByTestId(id).locator('svg').boundingBox();
    near(icon.width, 20, `${id} width`);
    near(icon.height, 20, `${id} height`);
    near((await page.getByTestId(id).boundingBox()).height, 44, `${id} touch target`);
  }
}

async function checkSwap(state) {
  await page.waitForFunction(state => {
    const swap = document.querySelector('[data-testid="nav-rail-toggle"] .t-icon-swap');
    if (swap?.dataset.state !== state) return false;
    return ['a', 'b'].every(icon => getComputedStyle(swap.querySelector(`[data-icon="${icon}"]`)).opacity === (icon === state ? '1' : '0'));
  }, state);
}

try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false,
      proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const password = 'sidebar-icons-test-123';
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  assert.equal((await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password } })).status(), 200);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByTestId('nav-rail').waitFor({ timeout: 60000 });
  const toggle = page.getByTestId('nav-rail-toggle');

  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion, colorScheme: reducedMotion === 'reduce' ? 'dark' : 'light' });
    await page.mouse.move(1000, 700);
    await checkIconSizes();
    await toggle.click();
    await page.getByTestId('nav-rail-compact').waitFor();
    await page.mouse.move(1000, 700);
    await checkIconSizes();
    assert.equal(await toggle.getAttribute('aria-label'), '展开侧边栏');
    await checkSwap('a');
    near((await toggle.locator('[data-icon="a"] svg').boundingBox()).width, 24, 'collapsed brand width');
    await toggle.hover();
    await checkSwap('b');
    near((await toggle.locator('[data-icon="b"] svg').boundingBox()).width, 20, 'expand icon width');
    await page.screenshot({ path: path.join(directory, `${reducedMotion}-hover.png`) });
    await page.mouse.move(1000, 700);
    await checkSwap('a');
    await page.screenshot({ path: path.join(directory, `${reducedMotion}-idle.png`) });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await checkSwap('b');
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    if (reducedMotion === 'reduce') {
      assert.equal(await toggle.locator('.t-icon').first().evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    }
    await page.keyboard.press('Enter');
    await page.getByTestId('nav-rail').waitFor();
    await checkIconSizes();
  }

  await toggle.click();
  await page.reload();
  await page.getByTestId('nav-rail-compact').waitFor();
  await checkIconSizes();
  await toggle.click();
  await page.getByTestId('nav-rail').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMenu = page.getByTestId('nav-rail-open');
  await mobileMenu.waitFor();
  assert.equal(await mobileMenu.locator('svg.tabler-icon-menu-2').count(), 1);
  await mobileMenu.click();
  await checkIconSizes();
  assert.deepEqual(errors, []);
  console.log(`PASS: stable navigation icon sizes; collapsed logo hover/focus swap; reduced motion; persisted collapse; mobile drawer. Evidence: ${directory}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png') });
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await app.close();
}
