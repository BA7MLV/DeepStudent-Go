import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Run against Vite: BASE_URL=http://127.0.0.1:5173 node scripts/e2e-copy-feedback.mjs
const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__copy-feedback-test', route => route.fulfill({
    contentType: 'text/html',
    body: `<html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script></body></html>`,
  }));
  await page.goto(`${base}/__copy-feedback-test`);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const client = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = client.default || client;
    const { Button, toast } = await import('/node_modules/.vite/deps/@heroui_react.js');
    const { CopyButton } = await import('/src/ui/copy-button.tsx');
    const { default: CodeBlock } = await import('/src/components/CodeBlock.tsx');
    const { default: PersistentError } = await import('/src/components/PersistentError.tsx');
    const { FeedbackHost, alertDialog } = await import('/src/ui/feedback.tsx');
    const { applyLocale } = await import('/src/i18n/index.ts');
    await import('/src/theme.css');
    await import('/src/transitions.css');
    const h = React.createElement;
    const root = createRoot(document.getElementById('root'));
    window.mode = 'success';
    window.writes = [];
    window.legacyWrites = [];
    window.useClipboard = () => Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: text => {
        window.writes.push(text);
        if (window.mode === 'failed') return Promise.reject(new Error('denied'));
        if (window.mode === 'pending') return new Promise(resolve => { window.resolveWrite = resolve; });
        return Promise.resolve();
      } },
    });
    window.useClipboard();
    document.execCommand = command => {
      window.legacyWrites.push({ command, value: document.activeElement?.value, synchronous: window.gestureStack });
      return window.mode !== 'failed';
    };
    window.clearToasts = () => toast.clear();
    window.applyLocale = applyLocale;
    window.showCopyDialog = () => alertDialog({ headline: '错误详情', description: '说明', copyText: 'dialog details' });
    window.renderFixture = (kind = 'normal') => root.render(h(React.StrictMode, {},
      h('main', { style: { padding: 32, display: 'grid', gap: 24 } },
        kind === 'empty' ? null : h('div', { style: { display: 'flex', gap: 12 } },
          h(CopyButton, { key: kind, text: kind === 'async' ? () => new Promise(resolve => { window.resolveText = resolve; }) : () => {
            window.gestureStack = true;
            queueMicrotask(() => { window.gestureStack = false; });
            return 'copied source';
          }, label: '复制 Markdown 源码', variant: 'tertiary', 'data-testid': 'copy' }),
          h(Button, { 'data-testid': 'neighbor' }, '相邻操作'),
          h(CopyButton, { text: 'icon source', label: '复制回答', isIconOnly: true, 'data-testid': 'icon-copy' })),
        h(CodeBlock, { source: 'const answer = 42;', language: 'js' }),
        h(PersistentError, { title: '出错了', text: 'error details', onClose() {} }),
        h(FeedbackHost))));
    window.renderFixture();
  });
  const copy = page.getByTestId('copy');
  const toast = page.locator('[data-slot="toast"]');
  await copy.waitFor();
  const initial = await copy.boundingBox();
  const neighbor = await page.getByTestId('neighbor').boundingBox();
  await copy.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="copy"]')?.dataset.copied === 'true');
  assert.equal(await copy.getAttribute('aria-label'), '已复制');
  assert.equal(await copy.getByRole('status').innerText(), '已复制');
  assert.equal((await copy.boundingBox()).width, initial.width, 'success preserves button width');
  assert.equal((await page.getByTestId('neighbor').boundingBox()).x, neighbor.x, 'neighbor does not shift');
  assert.equal(await toast.count(), 0, 'direct success must not emit a toast');
  assert.deepEqual(await page.evaluate(() => window.writes), ['copied source']);
  await page.waitForFunction(() => !document.querySelector('[data-testid="copy"]')?.dataset.copied);
  assert.equal(await copy.getAttribute('aria-label'), '复制 Markdown 源码');
  console.log('ok - direct copy, accessible status, stable width and automatic reset');

  await copy.click();
  await page.waitForTimeout(1000);
  await copy.click();
  await page.waitForTimeout(1000);
  assert.equal(await copy.getAttribute('data-copied'), 'true', 'a new copy restarts the success timer');
  await page.waitForFunction(() => !document.querySelector('[data-testid="copy"]')?.dataset.copied);
  console.log('ok - repeated copy restarts the timer');

  const icon = page.getByTestId('icon-copy');
  const iconWidth = (await icon.boundingBox()).width;
  await icon.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-testid="icon-copy"]')?.dataset.copied === 'true');
  assert.equal(await icon.getAttribute('aria-label'), '已复制');
  assert.equal((await icon.boundingBox()).width, iconWidth);
  assert.equal(await toast.count(), 0);
  console.log('ok - keyboard activation and icon-only success');

  await page.evaluate(() => { window.mode = 'failed'; });
  await copy.click();
  await page.getByText('复制失败，请重试', { exact: true }).waitFor();
  assert.equal(await copy.getAttribute('data-copied'), null);
  assert.equal(await toast.count(), 1, 'one failure toast, no false success');
  await page.evaluate(() => { window.clearToasts(); window.mode = 'success'; });
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  console.log('ok - rejected clipboard and fallback produce one error toast');

  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await copy.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="copy"]')?.dataset.copied === 'true');
  const legacy = await page.evaluate(() => window.legacyWrites.at(-1));
  assert.deepEqual(legacy, { command: 'copy', value: 'copied source', synchronous: true });
  assert.equal(await toast.count(), 0);
  await page.evaluate(() => window.useClipboard());
  console.log('ok - HTTP/legacy fallback preserves the synchronous user gesture');

  await page.getByTestId('code-block-more').click();
  await page.getByRole('menuitem', { name: '复制代码' }).click();
  await page.getByText('已复制源码', { exact: true }).waitFor();
  assert.equal(await toast.count(), 1);
  assert.equal(await page.evaluate(() => window.writes.at(-1)), 'const answer = 42;');
  await page.mouse.move(10, 750);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'), null, { timeout: 4000 });
  console.log('ok - menu copy emits a short success toast');

  await page.getByTestId('persistent-error-copy').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="persistent-error-copy"]')?.dataset.copied === 'true');
  assert.equal(await page.evaluate(() => window.writes.at(-1)), 'error details');
  assert.equal(await toast.count(), 0);
  await page.evaluate(() => { void window.showCopyDialog(); });
  await page.getByTestId('confirm-dialog-copy').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="confirm-dialog-copy"]')?.dataset.copied === 'true');
  assert.equal(await page.getByTestId('confirm-dialog').count(), 1, 'copy keeps the details dialog open');
  assert.equal(await page.evaluate(() => window.writes.at(-1)), 'dialog details');
  assert.equal(await toast.count(), 0);
  await page.getByTestId('confirm-dialog-cancel').click();
  console.log('ok - error details and dialog copies use inline feedback');

  await page.evaluate(() => { window.mode = 'pending'; });
  await copy.click();
  assert.equal(await copy.isDisabled(), true);
  await page.evaluate(() => { window.renderFixture('empty'); window.resolveWrite(); });
  await page.evaluate(() => { window.mode = 'success'; window.renderFixture('async'); });
  await copy.waitFor();
  await copy.click();
  assert.equal(await copy.isDisabled(), true);
  await page.evaluate(() => window.resolveText('async source'));
  await page.waitForFunction(() => document.querySelector('[data-testid="copy"]')?.dataset.copied === 'true');
  assert.equal(await page.evaluate(() => window.writes.at(-1)), 'async source');
  console.log('ok - async sources, pending state and unmount cleanup');

  await page.evaluate(() => window.applyLocale('en-US'));
  assert.equal(await copy.getAttribute('aria-label'), 'Copied');
  await page.evaluate(() => { window.renderFixture('normal'); window.mode = 'failed'; });
  await page.waitForFunction(() => !document.querySelector('[data-testid="copy"]')?.dataset.copied);
  await copy.click();
  await page.getByText('Copy failed. Please try again.', { exact: true }).waitFor();
  await page.evaluate(() => { window.clearToasts(); window.mode = 'success'; });
  await page.mouse.move(10, 750);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await copy.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="copy"]')?.dataset.copied === 'true');
  assert.equal(await copy.getAttribute('aria-label'), 'Copied');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  assert.deepEqual(errors, [], 'no browser errors');
  console.log('ok - English feedback, mobile viewport and reduced motion');
} finally {
  await browser.close();
}
