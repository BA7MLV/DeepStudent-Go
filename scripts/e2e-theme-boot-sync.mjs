import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce' });

const mockApi = (page) => {
  page.route('**/api/v1/cloud/status', (route) => route.fulfill({ json: { cloud: false } }));
  page.route('https://models.dev/**', (route) => route.fulfill({ json: {} }));
};

// 1. boot splash follows persisted theme, not just system preference
{
  const page = await context.newPage();
  mockApi(page);
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.route('**/config.js', (route) => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: { theme: 'light' } }));
  });
  await page.goto(`${base}/`);
  const state = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    scheme: document.documentElement.style.colorScheme,
    splash: getComputedStyle(document.querySelector('#boot-splash')).backgroundColor,
  }));
  assert.equal(state.dark, false, 'explicit light must win over dark system preference');
  assert.notEqual(state.splash, 'rgb(16, 16, 18)', 'light user must not get dark splash');
  await page.close();
}

// 2. auto theme still follows system preference before app JS
{
  const page = await context.newPage();
  mockApi(page);
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.route('**/config.js', (route) => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: { theme: 'auto' } }));
  });
  await page.goto(`${base}/`);
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  assert.equal(dark, true, 'auto theme must follow dark system preference');
  await page.close();
}

// 3. cross-tab sync via storage event
{
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  for (const page of [pageA, pageB]) {
    mockApi(page);
    page.addInitScript(() => {
      if (!localStorage.getItem('wangke-settings')) {
        localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: { theme: 'light' } }));
      }
    });
  }
  await pageA.goto(`${base}/#/chat`);
  await pageB.goto(`${base}/#/chat`);
  await pageA.getByTestId('top-app-bar').waitFor();
  await pageB.getByTestId('top-app-bar').waitFor();
  assert.equal(await pageB.evaluate(() => document.documentElement.classList.contains('dark')), false);
  await pageA.evaluate(async () => {
    const { useSettings } = await import('/src/store/settings.ts');
    useSettings.getState().update({ theme: 'dark' });
  });
  await pageB.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 10000 });
  assert.equal(await pageB.evaluate(() => document.documentElement.style.colorScheme), 'dark');
  await pageA.close();
  await pageB.close();
}

await browser.close();
console.log('PASS: splash follows persisted theme (light/auto), cross-tab storage sync applies dark live');
