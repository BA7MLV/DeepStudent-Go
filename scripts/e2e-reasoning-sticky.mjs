import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Isolated component fixture: no backend, login or user data required.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__reasoning-sticky-test', route => route.fulfill({
    contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>',
  }));
  await page.goto(`${process.env.BASE_URL || 'http://localhost:5198'}/__reasoning-sticky-test`);
  await page.evaluate(async () => {
    const { default: refresh } = await import('/@react-refresh');
    refresh.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: ReasoningChain } = await import('/src/components/ReasoningChain.tsx');
    await import('/src/theme.css');
    await import('/src/transitions.css');
    const style = document.createElement('style');
    style.textContent = `
      body { margin: 0; }
      .page-shell__surface { position: relative; }
      [data-testid="top-app-bar"] { position: fixed; inset: 0 0 auto; height: 60px; z-index: 5; }
      .course-chat__messages { height: 600px; overflow: auto; padding: 60px 20px 0; }
    `;
    document.head.append(style);
    const h = React.createElement;
    ReactDOM.createRoot(document.getElementById('root')).render(
      h('div', { className: 'page-shell__surface' },
        h('header', { 'data-testid': 'top-app-bar' }, 'Header'),
        h('div', { className: 'course-chat__messages' },
          h(ReasoningChain, { active: false, elapsedMs: 2300,
            reasoning: Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 步：检查思考过程的透明吸顶标题。`).join('\n\n') }),
          h('div', { style: { height: 900 } }, '后续回答'))));
  });
  const overlay = page.locator('.reasoning-chain__heading.chat-sticky-overlay');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        document.querySelector('.course-chat__messages').scrollTop = 0;
      }, theme);
      await overlay.waitFor({ state: 'detached' });
      await page.getByTestId('response-process-toggle').click();
      await page.locator('.reasoning-chain[data-mode="expanded"]').waitFor();
      await page.waitForFunction(() => document.querySelector('.reasoning-chain__body')?.getBoundingClientRect().height > 600
        && document.querySelector('.reasoning-chain__content')?.getBoundingClientRect().height > 600);
      await page.locator('.course-chat__messages').evaluate(el => { el.scrollTop = 300; });
      await overlay.waitFor();
      const top = (await overlay.boundingBox()).y;
      await page.locator('.course-chat__messages').evaluate(el => { el.scrollTop += 100; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(Math.abs((await overlay.boundingBox()).y - top) < 1, 'heading stays pinned');
      const state = await overlay.evaluate(el => {
        const bar = document.querySelector('[data-testid="top-app-bar"]');
        const r = bar.getBoundingClientRect();
        return { background: getComputedStyle(el).backgroundColor,
          belowHeader: Number(getComputedStyle(el).zIndex) < Number(getComputedStyle(bar).zIndex),
          headerOnTop: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === bar };
      });
      assert.deepEqual(state, { background: 'rgba(0, 0, 0, 0)', belowHeader: true, headerOnTop: true });
      await overlay.getByTestId('response-process-toggle').click();
      await overlay.waitFor({ state: 'detached' });
      assert.equal(await page.getByTestId('response-process-toggle').getAttribute('aria-expanded'), 'false');
      console.log(`PASS ${width}px/${theme}: transparent pinned reasoning below header, scrolling and collapse.`);
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
