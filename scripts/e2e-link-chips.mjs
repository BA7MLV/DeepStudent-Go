import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:5191';
const output = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'opencode', 'link-chips');
fs.mkdirSync(output, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3b8AAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [], external = [], iconRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(base) && /^https?:/.test(request.url())) external.push(request.url()); });
  await page.route('**/api/v1/link-icons?*', route => {
    const url = new URL(route.request().url());
    iconRequests.push(url);
    assert.deepEqual([...url.searchParams.keys()], ['origin']);
    const origin = url.searchParams.get('origin');
    assert.equal(new URL(origin).origin, origin, 'only origin, no page path or query');
    return origin === 'https://missing.example.org'
      ? route.fulfill({ status: 204 })
      : route.fulfill({ contentType: 'image/png', body: png });
  });
  // Exercise the real shared Markdown renderer and project styles without
  // logging in, mutating study data, or calling a live model/API.
  await page.route('**/__link-chip-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="link-chip-test" class="mr-md" style="max-width:720px;margin:24px auto;padding:20px;background:var(--background);color:var(--foreground)"></main></body></html>` }));
  await page.goto(`${base}/__link-chip-test`);
  await page.evaluate(async () => {
    const { default: refresh } = await import('/@react-refresh');
    refresh.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    await import('/src/theme.css');
    await import('/src/materials/material-reader.css');
    const react = await import('/node_modules/.vite/deps/react.js');
    const React = react.default || react;
    const client = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = client.default || client;
    const { Markdown } = await import('/src/components/markdown/Markdown.tsx');
    const root = createRoot(document.querySelector('#link-chip-test'));
    window.renderLinkTest = (content, streaming = false) => root.render(React.createElement(Markdown, { content, streaming: { hasNextChunk: streaming } }));
  });
  const host = page.locator('#link-chip-test');
  const content = `# 网站链接\n\n项目地址：https://github.com/openchamber/openchamber\n\n[Notion 官方文档](https://www.notion.com/help/create-links-and-backlinks)\n\n正文里的 [链接使用说明](https://www.notion.com/help/create-links-and-backlinks) 保留文字，不打断阅读。\n\n- [**URL API 参考**](https://developer.mozilla.org/en-US/docs/Web/API/URL)\n\n[这是一个非常长的资源标题，用于验证手机上可以正确截断且不会撑破正文布局](https://example.org/articles/long?token=private#part)\n\n[图标不可用时仍然可以打开](https://missing.example.org/path)\n\n[下载 PDF](https://example.org/file.pdf) · [站内跳转](#/library) · [邮件](mailto:hello@example.org) · [本站地址](${base}/help)\n\n[![关联图片](data:image/png;base64,${png.toString('base64')})](https://example.org/image-source)`;
  await page.evaluate(content => window.renderLinkTest(content), content);
  await page.waitForFunction(() => document.querySelectorAll('#link-chip-test .md-link-chip').length === 5);
  const chips = host.locator('.md-link-chip');
  assert.match(await chips.nth(0).innerText(), /^github.com\/openchamber\/openchamber/);
  assert.equal(await chips.nth(2).locator('strong').innerText(), 'URL API 参考', 'preserve inline label formatting');
  const plain = host.getByRole('link', { name: '链接使用说明', exact: true });
  assert.equal(await plain.getAttribute('class'), null);
  assert.equal(await host.locator('a:has(img[alt="关联图片"])').getAttribute('class'), null, 'linked images are not chips');
  for (const name of ['下载 PDF', '站内跳转', '邮件', '本站地址']) assert.equal(await host.getByRole('link', { name, exact: true }).getAttribute('class'), null);
  for (const chip of await chips.all()) {
    assert.equal(await chip.getAttribute('target'), '_blank');
    assert.match(await chip.getAttribute('rel'), /noopener/);
    assert.match(await chip.getAttribute('rel'), /noreferrer/);
    assert.ok((await chip.getAttribute('title')).includes(await chip.getAttribute('href')));
  }
  const missing = chips.filter({ hasText: '图标不可用时仍然可以打开' });
  await missing.locator('.md-link-chip__icon img').waitFor({ state: 'detached' });
  assert.equal(await missing.locator('.md-link-chip__icon svg').count(), 1, 'stable globe fallback');
  await page.waitForFunction(() => [...document.querySelectorAll('.md-link-chip__icon img')].every(img => img.complete && img.naturalWidth > 0));
  assert.equal(await chips.first().locator('[data-brand="github"]').count(), 1, 'GitHub brand is bundled');
  assert.equal(await chips.nth(1).locator('[data-brand="notion"]').count(), 1, 'Notion subdomain uses bundled brand');
  assert.equal(await chips.first().locator('img').count(), 0, 'bundled brands do not request remote icons');
  assert.ok(iconRequests.every(url => !/github|notion/.test(url.href)), 'brand icons never hit the API');
  const remote = chips.nth(2);
  await remote.locator('.md-link-chip__icon[data-loaded]').waitFor();
  assert.equal(await remote.locator('.md-link-chip__icon svg').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'transparent favicons do not overlap the fallback');
  const imageStyles = await remote.locator('img').evaluate(img => ({ width: img.getBoundingClientRect().width, margin: getComputedStyle(img).margin }));
  assert.ok(imageStyles.width > 10 && imageStyles.width < 20);
  assert.equal(imageStyles.margin, '0px');
  assert.equal(await chips.first().evaluate(el => getComputedStyle(el).textDecorationLine), 'none', 'reader link styles do not leak into chips');
  await chips.first().focus();
  assert.equal(await chips.first().evaluate(el => el.matches(':focus-visible')), true);
  await host.screenshot({ path: path.join(output, 'desktop-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await host.screenshot({ path: path.join(output, 'desktop-dark.png') });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  const bounds = await host.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(bounds.scroll <= bounds.width + 1, 'no horizontal overflow on phones');
  const long = chips.filter({ hasText: '这是一个非常长的资源标题' });
  assert.equal(await long.locator('.md-link-chip__label').evaluate(el => el.scrollWidth > el.clientWidth), true, 'long labels truncate');
  await host.screenshot({ path: path.join(output, 'mobile-light.png') });

  // Reuse the same mounted link after a host/error change; its favicon must reset.
  await page.evaluate(() => window.renderLinkTest('[失败图标](https://missing.example.org/path)'));
  await host.locator('.md-link-chip__icon img').waitFor({ state: 'detached' });
  await page.evaluate(() => window.renderLinkTest('[恢复图标](https://recovered.example.org/new)'));
  await host.locator('.md-link-chip__icon img').waitFor();
  assert.equal(new URL(await host.locator('.md-link-chip__icon img').getAttribute('src'), base).searchParams.get('origin'), 'https://recovered.example.org');
  await host.locator('.md-link-chip__icon[data-loaded]').waitFor();
  const beforeBrand = iconRequests.length;
  await page.evaluate(() => window.renderLinkTest('[内置图标](https://www.bilibili.com/video/BV1)'));
  await host.locator('[data-brand="bilibili"]').waitFor();
  assert.equal(await host.locator('.md-link-chip__icon img').count(), 0);
  assert.equal(iconRequests.length, beforeBrand);
  await page.evaluate(() => window.renderLinkTest('[自定义端口](https://custom.example.org:8080/path)'));
  await host.getByRole('link', { name: /自定义端口/ }).waitFor();
  assert.equal(await host.locator('.md-link-chip__icon img').count(), 0, 'nonstandard ports use globe without a fetch');
  assert.equal(iconRequests.length, beforeBrand);

  await page.evaluate(() => window.renderLinkTest('[查看材料原图](#source-image/course/page-3)'));
  await host.locator('.material-image-link').waitFor();
  assert.equal(await host.locator('.md-link-chip').count(), 0, 'material image references retain their own preview renderer');
  assert.equal(await host.getByRole('link', { name: '查看材料原图' }).getAttribute('href'), '#source-image/course/page-3');

  const beforeStream = iconRequests.length;
  await page.evaluate(() => window.renderLinkTest('[参考资料](https://stream.example.org/part', true));
  await page.waitForFunction(() => document.querySelector('#link-chip-test')?.textContent.includes('参考资料'));
  assert.equal(await host.locator('a').count(), 0, 'incomplete Markdown URL remains inert');
  assert.equal(iconRequests.length, beforeStream, 'incomplete URLs do not request icons');
  await page.evaluate(() => window.renderLinkTest('[参考资料](https://stream.example.org/part)', false));
  await host.locator('.md-link-chip').waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], 'browser never contacts a third-party icon provider or linked site');
  assert.ok(iconRequests.every(url => !url.href.includes('private')), 'page queries are never sent to the icon route');
  console.log('Browser Link chips: actual Markdown, labels, exclusions, streaming, focus, fallback/reset, mobile overflow, reader CSS, light/dark screenshots and no external requests passed.');
} finally { await browser.close(); }
