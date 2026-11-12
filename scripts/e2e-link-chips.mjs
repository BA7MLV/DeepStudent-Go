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
let releaseDelayedIcon;
const delayedIcon = new Promise(resolve => { releaseDelayedIcon = resolve; });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [], external = [], iconRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(base) && /^https?:/.test(request.url())) external.push(request.url()); });
  await page.route('**/api/v1/link-icons?*', async route => {
    const url = new URL(route.request().url());
    iconRequests.push(url);
    assert.deepEqual([...url.searchParams.keys()], ['origin']);
    const origin = url.searchParams.get('origin');
    if (origin === 'https://delayed.example.org') await delayedIcon;
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
    await import('/src/i18n/index.ts');
    const react = await import('/node_modules/.vite/deps/react.js');
    const React = react.default || react;
    const client = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = client.default || client;
    const { Markdown } = await import('/src/components/markdown/Markdown.tsx');
    const { WebsiteCitations } = await import('/src/components/markdown/WebsiteCitations.tsx');
    const { default: BotRich } = await import('/src/pages/BotRich.tsx');
    const { default: ReasoningMarkdown } = await import('/src/components/ReasoningMarkdown.tsx');
    const root = createRoot(document.querySelector('#link-chip-test'));
    window.renderLinkTest = (content, streaming = false) => root.render(React.createElement(Markdown, { content, streaming: { hasNextChunk: streaming } }));
    window.renderCitationTest = (content, streaming = false, reasoning = '') => root.render(React.createElement(WebsiteCitations, { content, streaming },
      reasoning ? React.createElement(ReasoningMarkdown, { content: reasoning }) : null,
      content.split('\n\n<!-- split -->\n\n').map((part, index) => React.createElement(Markdown, { key: index, content: part, streaming: { hasNextChunk: streaming } }))));
    window.renderBotCitationTest = content => root.render(React.createElement(BotRich, { content }));
  });
  const host = page.locator('#link-chip-test');
  const content = `# 网站链接\n\n项目地址：https://github.com/openchamber/openchamber\n\n[Notion 官方文档](https://www.notion.com/help/create-links-and-backlinks)\n\n正文里的 [链接使用说明](https://www.notion.com/help/create-links-and-backlinks) 保留文字，不打断阅读。\n\n- [**URL API 参考**](https://developer.mozilla.org/en-US/docs/Web/API/URL)\n\n[这是一个非常长的资源标题，用于验证手机上可以正确截断且不会撑破正文布局](https://example.org/articles/long?token=private#part)\n\n[图标不可用时仍然可以打开](https://missing.example.org/path)\n\n[下载 PDF](https://example.org/file.pdf) · [站内跳转](#/library) · [邮件](mailto:hello@example.org) · [本站地址](${base}/help)\n\n[![关联图片](data:image/png;base64,${png.toString('base64')})](https://example.org/image-source)`;
  await page.evaluate(content => window.renderLinkTest(content), content);
  await page.waitForFunction(() => document.querySelectorAll('#link-chip-test .md-link-chip').length === 6);
  const chips = host.locator('.md-link-chip');
  assert.match(await chips.nth(0).innerText(), /^github.com\/openchamber\/openchamber/);
  assert.equal(await chips.nth(3).locator('strong').innerText(), 'URL API 参考', 'preserve inline label formatting');
  const inline = host.getByRole('link', { name: /链接使用说明/ });
  assert.equal(await inline.getAttribute('class'), 'md-link-chip', 'inline and standalone websites share one presentation');
  assert.equal(await inline.locator('[data-brand="notion"]').count(), 1);
  assert.equal(await inline.locator('.md-link-chip__label').innerText(), '链接使用说明', 'inline prose keeps its original label');
  assert.equal(await inline.evaluate(el => getComputedStyle(el).backgroundColor), await chips.nth(1).evaluate(el => getComputedStyle(el).backgroundColor));
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
  const remote = chips.nth(3);
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

  // Chat mode: numeric references share one footer even across Markdown segments.
  await page.setViewportSize({ width: 1000, height: 900 });
  const citationContent = `# 今日新闻（排版示例）\n\n科技动态已公布新进展。[**官方公告**](https://github.com/blog "官方来源")\n\n<!-- split -->\n\n后续更新沿用同一来源。[再次引用](https://GITHUB.com/blog)\n\n另一家媒体也进行了报道。[媒体报道](https://missing.example.org/report?token=private)\n\n[下载 PDF](https://example.org/file.pdf) · [站内跳转](#/library)`;
  await page.evaluate(content => window.renderCitationTest(content), citationContent);
  const references = host.locator('.md-website-citation a'), footer = host.getByTestId('website-sources');
  await references.nth(2).waitFor();
  assert.deepEqual(await references.allTextContents(), ['[1]', '[1]', '[2]']);
  assert.equal(await host.locator('.md-link-chip').count(), 0, 'chat prose no longer contains chips');
  assert.equal(await references.locator('svg,img,strong').count(), 0, 'body shows just superscript numbers');
  assert.equal(await references.first().locator('..').evaluate(el => getComputedStyle(el).verticalAlign), 'super');
  assert.match(await references.first().getAttribute('title'), /官方来源/);
  assert.match(await references.first().getAttribute('aria-label'), /官方公告/);
  assert.equal(await footer.count(), 1);
  assert.equal(await footer.locator('.website-sources__label').innerText(), '引用来源');
  const sourceIcons = footer.locator('.website-sources__icon');
  assert.equal(await sourceIcons.count(), 2);
  assert.equal(await sourceIcons.first().locator('[data-brand="github"]').count(), 1);
  await sourceIcons.nth(1).locator('img').waitFor({ state: 'detached' });
  assert.equal(await sourceIcons.nth(1).locator('svg').evaluate(el => getComputedStyle(el).visibility), 'visible', 'globe is the default when no favicon loads');
  assert.equal(await sourceIcons.evaluateAll(links => links[1].getBoundingClientRect().left < links[0].getBoundingClientRect().right), true);
  assert.equal(await footer.evaluate(el => [...el.parentElement.querySelectorAll('.x-markdown')].every(body => body.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  for (const link of await references.all()) {
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match(await link.getAttribute('rel'), /noopener/);
    await link.focus();
    assert.equal(await link.evaluate(el => el.matches(':focus-visible')), true);
  }
  for (const icon of await sourceIcons.all()) {
    assert.equal(await icon.getAttribute('target'), '_blank');
    assert.match(await icon.getAttribute('rel'), /noreferrer/);
    await icon.focus();
    assert.equal(await icon.evaluate(el => el.matches(':focus-visible')), true, 'overlapping icons are individually keyboard accessible');
  }
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await host.screenshot({ path: path.join(output, 'citations-desktop-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await host.screenshot({ path: path.join(output, 'citations-desktop-dark.png') });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.setViewportSize({ width: 360, height: 900 });
  await host.screenshot({ path: path.join(output, 'citations-mobile.png') });
  assert.equal(await host.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);

  const streamingCitation = '[已完成](https://github.com/blog)\n\n继续 [参考资料](https://stream-citation.example.org/part';
  const beforePending = iconRequests.length;
  await page.evaluate(content => window.renderCitationTest(content, true), streamingCitation);
  await page.waitForFunction(() => document.querySelectorAll('.md-website-citation').length === 1);
  assert.equal(await sourceIcons.count(), 1, 'unfinished links do not add footer entries');
  assert.equal(iconRequests.length, beforePending, 'unfinished citations never fetch a favicon');
  await page.evaluate(content => window.renderCitationTest(content + ')', false), streamingCitation);
  await references.nth(1).waitFor();
  assert.deepEqual(await references.allTextContents(), ['[1]', '[2]']);
  assert.equal(await sourceIcons.count(), 2);
  await page.evaluate(content => window.renderCitationTest(content, false, '[仅推理中出现的链接](https://github.com/blog)'), streamingCitation + ')');
  await host.locator('.reasoning-markdown .md-link-chip').waitFor();
  assert.equal(await host.locator('.reasoning-markdown .md-website-citation').count(), 0, 'process text does not borrow answer citation numbers');
  assert.equal(await sourceIcons.count(), 2, 'reasoning never adds extra answer sources');
  await page.evaluate(() => window.renderCitationTest('生成中的来源。[新来源](https://delayed.example.org/page)'));
  const delayed = sourceIcons.first();
  await delayed.locator('img').waitFor({ state: 'attached' });
  assert.equal(await delayed.locator('svg').evaluate(el => getComputedStyle(el).visibility), 'visible', 'pending favicons start as a globe');
  releaseDelayedIcon();
  await delayed.locator('[data-loaded]').waitFor();
  assert.equal(await delayed.locator('svg').evaluate(el => getComputedStyle(el).visibility), 'hidden');
  await page.evaluate(() => window.renderCitationTest('没有引用的普通回答。'));
  await footer.waitFor({ state: 'detached' });
  const crowded = Array.from({ length: 40 }, (_, i) => `[来源 ${i + 1}](https://github.com/page-${i})`).join(' ');
  await page.evaluate(content => window.renderCitationTest(content), crowded);
  await sourceIcons.nth(39).waitFor();
  assert.equal(await host.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'long icon stacks wrap without losing sources');
  await page.evaluate(() => window.renderBotCitationTest('机器人回答也使用相同的来源组。[官方文档](https://github.com/docs)'));
  await host.locator('.imsg-rich .md-website-citation').waitFor();
  assert.equal(await sourceIcons.count(), 1);
  assert.equal(await host.locator('.imsg-rich .md-link-chip').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], 'browser never contacts a third-party icon provider or linked site');
  assert.ok(iconRequests.every(url => !url.href.includes('private')), 'page queries are never sent to the icon route');
  console.log('Browser links/citations: shared chips, numeric chat references, deduplication across segments, bottom icon stack, streaming, focus, globe fallback/reset, mobile overflow, light/dark screenshots and no external requests passed.');
} finally { releaseDelayedIcon(); await browser.close(); }
