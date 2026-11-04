import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Mock account status only; never submit passwords or access a real account.
const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];

try {
  for (const cloud of [true, false]) {
    for (const width of [390, 1440]) {
      for (const hasPasskey of [false, true, undefined]) {
        const context = await browser.newContext({
          locale: 'zh-CN', viewport: { width, height: 900 }, reducedMotion: 'reduce',
        });
        try {
          await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud } }));
          await context.route('**/api/v1/bootstrap/status', route => route.fulfill({ json: { initialized: true, hasPasskey } }));
          await context.route('**/api/v1/auth/session', route => route.fulfill({ json: { authenticated: false, user: null } }));
          await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
          const page = await context.newPage();
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`${base}${cloud ? '' : '/#/bot'}`);
          await page.locator(cloud ? '.ob__form' : '.bot-access__form').waitFor();
          const passkey = page.getByRole('button', { name: /使用 Passkey/ });
          assert.equal(await passkey.count(), hasPasskey === true ? 1 : 0);
          assert.equal(await page.getByRole('button', { name: '登录', exact: true }).isVisible(), true);
          assert.equal(await page.getByLabel('密码', { exact: true }).isVisible(), true);
          console.log(`OK: ${cloud ? 'cloud' : 'Bot'} login at ${width}px / hasPasskey=${hasPasskey}`);
        } finally {
          await context.close();
        }
      }
    }
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
} finally {
  await browser.close();
}
