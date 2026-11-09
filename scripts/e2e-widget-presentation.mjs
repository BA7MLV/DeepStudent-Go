// Independent works auto-render; ordinary titled HTML remains click-to-preview.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/widget-presentation-');
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import WidgetMessage from '/src/components/WidgetMessage.tsx';
import { Markdown } from '/src/components/markdown/Markdown.tsx';
import { MarkdownCode, MarkdownPre } from '/src/components/mermaid/markdown.tsx';
import '/src/i18n';
import '/src/theme.css';
const root = createRoot(document.getElementById('root'));
window.render = (payload, example) => {
  const content = '作品讲解\\n\\n' + (payload ? '\u0060\u0060\u0060wbw-widget\\n' + payload.ref + '\\n\u0060\u0060\u0060\\n\\n' : '') + example;
  root.render(React.createElement(WidgetMessage, {message:{widgets:payload ? [payload] : []}, content, dark:false},
    markdown => React.createElement(Markdown, {content:markdown, components:{code:MarkdownCode,pre:MarkdownPre}})));
};
document.body.dataset.ready = 'yes';`;
let server, browser;
try {
  server = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'cache'), plugins: [{ name: 'widget-presentation-fixture',
      resolveId: id => id === '/__presentation.js' ? '\0presentation' : undefined,
      load: id => id === '\0presentation' ? fixture : undefined,
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== '/__presentation') return next();
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="root" style="max-width:720px;margin:auto;padding:12px"></main><script type="module" src="/__presentation.js"></script>');
      }); },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
  await server.listen();
  browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + '__presentation');
  await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  const html = '<section><button>增加</button><output>0</output></section><script>var count=0;document.querySelector("button").onclick=()=>document.querySelector("output").textContent=++count;</script>';
  const payload = { id: 'work', ref: 'work', source: 'tool', kind: 'html', schemaVersion: 1, revision: 1, title: '计数变化演示', html };
  const example = '```html title="普通代码标题"\n<section><h2>代码里的标题</h2><output>未运行</output></section><script>document.querySelector("output").textContent="示例已运行"</script>\n```';
  const render = (value = payload, code = example) => page.evaluate(({ value, code }) => window.render(value, code), { value, code });
  await render();
  await page.getByTestId('widget-title').waitFor();
  assert.equal(await page.getByTestId('widget-title').innerText(), payload.title);
  const work = page.getByTestId('widget-frame').first();
  await work.contentFrame().getByRole('button', { name: '增加' }).waitFor();
  assert.equal(await work.getAttribute('title'), payload.title);
  assert.equal(await work.getAttribute('sandbox'), 'allow-scripts');
  await work.contentFrame().getByRole('button', { name: '增加' }).click();
  assert.equal(await work.contentFrame().locator('output').innerText(), '1');
  const originalFrame = await work.elementHandle();
  const code = page.getByTestId('html-code-example');
  await code.getByTestId('code-block').waitFor();
  assert.equal(await code.getByTestId('widget-frame').count(), 0, 'HTML title and script do not authorize auto-rendering');
  assert.equal(await page.getByTestId('code-block').count(), 1, 'only the ordinary example uses a code card');
  await render({ ...payload, title: '修改后的作品标题' });
  await page.getByTestId('widget-title').filter({ hasText: '修改后的作品标题' }).waitFor();
  assert.equal(await originalFrame.evaluate(element => element.isConnected), true, 'title-only changes do not remount the sandbox');
  assert.equal(await work.contentFrame().locator('output').innerText(), '1');
  await page.getByRole('button', { name: '更多交互图形操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '查看 HTML 源码', exact: true }).click();
  assert.equal(await page.getByTestId('widget-source').innerText(), html);
  assert.equal(await originalFrame.evaluate(element => element.isConnected), true, 'source toggle preserves running state');
  await code.getByTestId('code-block-more').click();
  await page.getByRole('menuitem', { name: '预览', exact: true }).click();
  await code.getByTestId('widget-frame').contentFrame().getByText('示例已运行', { exact: true }).waitFor();
  await code.getByTestId('code-block-more').click();
  await page.getByRole('menuitem', { name: '查看代码', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '更多交互图形操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '收起 HTML 源码', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  for (const width of [320, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.locator('#root').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  }
  await page.screenshot({ path: path.join(directory, 'titled-work-and-code.png') });
  await render({ ...payload, title: undefined }, '');
  await page.getByTestId('widget-title').waitFor({ state: 'detached' });
  await work.contentFrame().getByRole('button', { name: '增加' }).waitFor();
  assert.equal(await originalFrame.evaluate(element => element.isConnected), true, 'removing an optional title preserves the sandbox');
  assert.equal(await work.contentFrame().locator('output').innerText(), '1');
  await render({ ...payload, schemaVersion: 99 }, '');
  await page.getByRole('alert').filter({ hasText: '协议版本暂不支持' }).waitFor();
  assert.equal(await page.getByTestId('widget-frame').count(), 0, 'auto-rendering never bypasses payload validation');
  assert.deepEqual(errors, []);
  console.log(`PASS ${process.env.BROWSER || 'chromium'}: works auto-render with or without a title, ordinary HTML requires a click, title/source changes preserve state, invalid protocol rejected, 320/1100px. Screenshot: ${directory}`);
} finally {
  await browser?.close();
  await server?.close();
}
