import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// 仅模拟登录入口，不访问真实账号，也不发送密码。
const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];

try {
  for (const width of [390, 1440]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        locale: 'zh-CN', viewport: { width, height: 900 }, colorScheme: theme,
      });
      await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: true } }));
      await context.route('**/api/v1/bootstrap/status', route => route.fulfill({ json: { initialized: true } }));
      await context.route('**/api/v1/auth/session', route => route.fulfill({ json: { authenticated: false, user: null } }));
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.getByRole('heading', { name: 'DeepStudent Go', exact: true }).waitFor();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('.ob__form').evaluate(async node => {
        await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });

      const input = page.getByLabel('密码', { exact: true });
      const submit = page.getByRole('button', { name: '登录', exact: true });
      assert.equal(await submit.isDisabled(), true);
      await input.fill('local-layout-test');
      assert.equal(await submit.isEnabled(), true);
      assert.equal(await input.getAttribute('type'), 'password');
      assert.equal(await input.getAttribute('autocomplete'), 'current-password');

      const layout = await page.locator('.ob__group').evaluate(group => {
        const field = group.querySelector('input');
        const scene = group.closest('.ob__scene');
        const box = group.getBoundingClientRect();
        const clip = scene.getBoundingClientRect();
        return {
          height: box.height,
          fieldHeight: field.getBoundingClientRect().height,
          leftSpace: box.left - clip.left,
          rightSpace: clip.right - box.right,
          shadow: getComputedStyle(group).boxShadow,
          radius: getComputedStyle(group).borderRadius,
          innerRadius: getComputedStyle(field).borderRadius,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.equal(layout.height, 48);
      assert.equal(layout.fieldHeight, 48);
      assert.ok(layout.leftSpace >= 3 && layout.rightSpace >= 3, 'focus ring fits inside the scroll container');
      assert.match(layout.shadow, /inset/, 'border stays inside the rounded group');
      assert.notEqual(layout.radius, '0px');
      assert.equal(layout.innerRadius, '0px', 'only the group draws the rounded border');
      assert.equal(layout.overflow, false);

      await input.fill('');
      assert.equal(await submit.isDisabled(), true);
      await page.locator('.ob__title').click();
      assert.equal(await input.evaluate(node => node === document.activeElement), false);
      assert.match(await page.locator('.ob__group').evaluate(node => getComputedStyle(node).boxShadow), /inset/);
      await page.locator('.ob__label').click();
      assert.equal(await input.evaluate(node => node === document.activeElement), true);
      console.log(`OK: login branding, password layout and focus at ${width}px / ${theme}`);
      await context.close();
    }
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
} finally {
  await browser.close();
}
