import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// 模拟 SW 接管事件和未登录的启动接口，不访问真实账号。
const BASE = process.env.BASE_URL || 'http://localhost:4173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];

try {
  for (const [locale, hadController, label, viewport] of [
    ['zh-CN', false, '立即刷新', { width: 1440, height: 1000 }],
    ['en-US', true, 'Refresh now', { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ locale, viewport });
    await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: true } }));
    await context.route('**/api/v1/bootstrap/status', route => route.fulfill({ json: { initialized: true } }));
    await context.route('**/api/v1/auth/session', route => route.fulfill({ json: { authenticated: false, user: null } }));
    await context.addInitScript(({ locale, hadController }) => {
      localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: { uiLanguage: locale } }));
      const serviceWorker = new EventTarget();
      serviceWorker.controller = hadController ? {} : null;
      serviceWorker.register = async () => ({ addEventListener() {} });
      serviceWorker.getRegistration = async () => undefined;
      Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker });
    }, { locale, hadController });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${BASE}/#/settings/appearance`);
    const password = page.locator('input[type="password"]');
    await password.fill('keep-this-draft');
    await page.evaluate(() => { window.__updateDocument = document; });

    if (!hadController) {
      await page.evaluate(() => {
        navigator.serviceWorker.controller = {};
        navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
      });
      assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0, '首次接管不提示');
    }

    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
    const refresh = page.getByRole('button', { name: label, exact: true });
    await refresh.waitFor();
    // 超过原来的 3 秒期限仍可操作；不自动刷新、不丢当前输入。
    await page.mouse.move(0, 0);
    await page.waitForTimeout(3500);
    assert.equal(await refresh.isVisible(), true);
    assert.equal(await password.inputValue(), 'keep-this-draft');
    assert.equal(await page.evaluate(() => window.__updateDocument === document), true);
    await Promise.all([page.waitForEvent('domcontentloaded'), refresh.click()]);
    await password.waitFor();
    assert.equal(await password.inputValue(), '');
    assert.equal(new URL(page.url()).hash, '#/settings/appearance');
    assert.equal(await refresh.count(), 0);
    await context.close();
    console.log(`OK: ${locale} update action persists, preserves input until clicked, and reloads the current URL`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
