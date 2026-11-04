import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const output = process.env.SHOTS;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  const input = page.locator('textarea.course-chat__input');
  const backdrop = page.locator('.course-chat__composer-blur');
  await input.waitFor();
  await page.waitForFunction(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().loaded);
  const setState = state => page.evaluate(async next => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    useCourseChat.setState(next);
  }, state);
  const checkGeometry = async () => {
    await page.waitForFunction(() => {
      const card = document.querySelector('.course-chat__composer').getBoundingClientRect();
      const blur = document.querySelector('.course-chat__composer-blur').getBoundingClientRect();
      return Math.abs(blur.top - (card.top + card.height / 2)) < 1;
    });
    const card = await page.locator('.course-chat__composer').boundingBox();
    const blur = await backdrop.boundingBox();
    const main = await page.locator('.course-chat__main').boundingBox();
    assert.ok(blur.y >= card.y + card.height / 2 - 0.5, 'blur never extends above the card midpoint');
    assert.ok(Math.abs(blur.y + blur.height - main.y - main.height) < 1, 'blur reaches the bottom edge');
    assert.ok(main.y + main.height - card.y - card.height >= 11, 'bottom corners and shadow have visible clearance');
    assert.equal(await page.locator('.course-chat__messages').evaluate(el => getComputedStyle(el).clipPath), 'none', 'messages remain visible behind and below the input');
    assert.equal(await backdrop.evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    assert.equal(await page.locator('.course-chat__composer').evaluate(el => getComputedStyle(el).backdropFilter), 'none', 'the input card itself stays sharp');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  };

  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await setState({ draft: '', messages: [], queued: [] });
    assert.equal(await backdrop.evaluate(el => getComputedStyle(el).display), 'none', 'welcome screen has no bottom backdrop');
    await setState({ messages: [
      { key: 'question', role: 'user', content: '请解释这些知识点' },
      { key: 'answer', role: 'ai', content: Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 段：滚动内容在输入栏的两侧和底部仍然可见，只在中线以下逐渐模糊。`).join('\n\n') },
    ] });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      await checkGeometry();
      assert.deepEqual(await backdrop.locator('span').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).backdropFilter)), ['blur(1px)', 'blur(4px)', 'blur(12px)', 'blur(24px)']);
      await page.locator('.course-chat__messages').evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (output) await page.screenshot({ path: path.join(output, `${width}-${theme}.png`), animations: 'disabled' });
    }
    await input.fill('多行草稿\n'.repeat(30));
    await checkGeometry();
    await setState({ queued: [{ id: 'backdrop-queue', text: '排队消息', createdAt: Date.now() }] });
    await page.getByTestId('chat-queue').waitFor();
    await checkGeometry();
    await page.setViewportSize({ width, height: 450 });
    await checkGeometry();
    console.log(`PASS ${width}px: midpoint-limited progressive blur, visible bottom edge, light/dark, growing draft, queue and reduced viewport`);
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  assert.equal(await backdrop.locator('span').first().evaluate(el => getComputedStyle(el).display), 'none', 'reduced transparency disables backdrop filters');
  await checkGeometry();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
