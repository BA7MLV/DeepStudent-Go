import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const before = process.env.TYPOGRAPHY_BEFORE === '1';
const phase = before ? 'before' : 'after';
const shots = path.resolve('test-results/typography');
await mkdir(shots, { recursive: true });
const vite = await createServer({ root: path.resolve('apps/web'), server: { host: '127.0.0.1', port: 0 },
  plugins: before ? [{ name: 'typography-baseline', enforce: 'pre', load(id) {
    const file = path.relative(process.cwd(), id.split('?')[0]);
    if (['apps/web/src/theme.css', 'apps/web/src/pages/resources.css', 'apps/web/src/ui/skeleton.css', 'apps/web/src/utils/format.ts'].includes(file)) {
      return execFileSync('git', ['show', `${process.env.TYPOGRAPHY_BASE_REF || 'HEAD'}:${file}`], { encoding: 'utf8' });
    }
    if (file === 'apps/web/src/ui/overflowTitle.ts') return 'export function updateOverflowTitle() {} export const overflowTitleProps = {};';
  } }] : [],
});
let browser;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 1100, height: 900 } });
  await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('textarea.course-chat__input').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('textarea.course-chat__input').disabled);
  // Isolated browser storage + the real chat store/renderers; no requests to an AI provider.
  await page.evaluate(async () => {
    const module = name => {
      const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === name);
      return import(entry?.name ?? name);
    };
    const { useCourseChat } = await module('/src/store/courseChat.ts');
    const content = [
      '## Building a clearer understanding of complex learning materials together',
      'A useful study note connects the central idea with examples you can revisit. Keep the explanation readable so that the final sentence feels complete rather than leaving one small word behind. This matters.',
      '使用DeepStudent整理PDF和Markdown资料，结合AI回答复习第12章内容。每次阅读后记录3个问题，再回到原文检查关键概念，帮助理解中文与English混排的学习笔记。',
      '- Keep related ideas together when reviewing a long explanation and its supporting examples.',
      '`const 示例 = "PDF解析12次";`',
    ].join('\n\n');
    const id = 987654;
    useCourseChat.setState({ ready: true, loaded: true, activeId: id,
      sessions: [{ id, title: 'DeepStudent 中文学习资料与 English reading notes 的长会话标题：第12章复习与关键概念整理', createdAt: Date.now(), updatedAt: Date.now() }],
      messages: [{ key: 'typography-fixture', role: 'ai', content, createdAt: Date.now(),
        reasoning: '先阅读课程内容，再核对关键概念。', reasoningMs: 1111 }],
    });
  });
  await page.locator('.x-markdown h2').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: path.join(shots, `chat-${phase}-desktop.png`), animations: 'disabled' });
  const report = await page.evaluate(() => {
    const heading = document.querySelector('.x-markdown h2');
    const paragraphs = [...document.querySelectorAll('.x-markdown:not(.reasoning-markdown) p')];
    return { headingWrap: getComputedStyle(heading).textWrap,
      paragraphWrap: getComputedStyle(paragraphs[0]).textWrap,
      mixedAutospace: getComputedStyle(paragraphs[1]).getPropertyValue('text-autospace'),
      supported: { balance: CSS.supports('text-wrap', 'balance'), pretty: CSS.supports('text-wrap', 'pretty'),
        autospace: CSS.supports('text-autospace', 'normal'), trim: CSS.supports('text-spacing-trim', 'trim-start') } };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  report.paragraphEnding = await page.locator('.x-markdown:not(.reasoning-markdown) p').first().evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const words = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of node.textContent.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
        words.push({ word: match[0], top: range.getBoundingClientRect().top });
      }
    }
    const bottom = Math.max(...words.map(word => word.top));
    return words.filter(word => Math.abs(word.top - bottom) < 1).map(word => word.word).join(' ');
  });
  const title = page.getByTestId('page-title');
  await title.hover();
  report.truncated = await title.evaluate(el => ({ overflow: el.scrollWidth > el.clientWidth, title: el.title, text: el.textContent }));
  await page.screenshot({ path: path.join(shots, `chat-${phase}-mobile.png`), animations: 'disabled' });
  if (!before) {
    assert.equal(report.headingWrap, 'wrap');
    assert.equal(report.paragraphWrap, 'wrap');
    assert.equal(report.truncated.overflow, true);
    assert.equal(report.truncated.title, report.truncated.text);
  }

  // Existing live timer: verify real text advances, not a fixed-width container.
  await page.evaluate(async () => {
    const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === '/src/store/courseChat.ts');
    const { useCourseChat } = await import(entry.name);
    const state = useCourseChat.getState();
    useCourseChat.setState({ messages: state.messages.map(message => ({ ...message, streaming: true, processPhase: 'thinking', processStartedAt: Date.now() - 11100 })) });
  });
  const elapsed = page.getByTestId('reasoning-elapsed');
  await elapsed.waitFor();
  report.timer = await elapsed.evaluate(el => {
    const original = el.textContent;
    const measure = text => {
      el.textContent = text;
      const range = document.createRange(); range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const widths = ['已用时 11.1 秒', '已用时 88.8 秒', '已用时 99.9 秒'].map(measure);
    el.textContent = original;
    return { numeric: getComputedStyle(el).fontVariantNumeric, font: getComputedStyle(el).fontFamily, widths };
  });
  assert.equal(report.timer.numeric, 'tabular-nums');
  assert.ok(Math.max(...report.timer.widths) - Math.min(...report.timer.widths) < 0.1);
  await page.screenshot({ path: path.join(shots, `timer-${phase}-mobile.png`), animations: 'disabled' });

  // Real library page + read-only fixture API; no user account or live data.
  const longName = '第12章_中文与English混排的课程讲义和阅读笔记_DeepStudent学习资料整理_最终复习版.pdf';
  await context.route('**/api/v1/resources?**', route => route.fulfill({ json: { entries: [
    { projectId: 'typography', path: longName, name: longName, kind: 'file', size: 1024 ** 2 },
    { projectId: 'typography', path: 'notes.md', name: 'notes.md', kind: 'file', size: 1024 },
  ], path: '' } }));
  await page.evaluate(async () => {
    const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === '/src/cloud/state.ts');
    const { cloud } = await import(entry.name); cloud.enabled = true;
    location.hash = '/library';
  });
  await page.getByTestId('resource-entry').first().waitFor();
  await page.getByRole('button', { name: '切换显示方式', exact: true }).click();
  const fileName = page.locator('.resource-open > span').filter({ hasText: longName }).first();
  await fileName.hover();
  report.file = await fileName.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, title: el.title,
    text: el.textContent, overflow: getComputedStyle(el).textOverflow, whiteSpace: getComputedStyle(el).whiteSpace }));
  await page.screenshot({ path: path.join(shots, `library-${phase}-mobile.png`), animations: 'disabled' });
  if (!before) {
    assert.equal(report.file.overflow, 'ellipsis');
    assert.equal(report.file.whiteSpace, 'nowrap');
    assert.ok(report.file.scroll > report.file.width);
    assert.equal(report.file.title, longName);
    const short = page.locator('.resource-open > span').filter({ hasText: /^notes\.md$/ });
    await short.hover();
    assert.equal(await short.getAttribute('title'), null, 'untruncated label has no redundant hint');

    // Global defaults, English islands and literal text are checked in the actual
    // compiled stylesheet, not just by matching declarations in source files.
    report.defaults = await page.evaluate(() => {
      const host = document.createElement('section'); host.style.cssText = 'position:fixed;left:-10000px';
      host.className = 'x-markdown';
      host.innerHTML = '<p lang="en">English <span>only</span></p><code><span>中文PDF12</span></code><input value="中文PDF12"><div class="font-mono"><span>中文PDF12</span></div><div class="hd-para">（首行缩进）中文PDF12</div><table><tr><td>1234</td></tr></table><output>1234</output><button class="button">按钮 Label</button><div class="ui-field__hint">提示文本</div><div class="md-embedded-ui"><p>内嵌UI</p></div>';
      document.body.append(host);
      const spacing = selector => getComputedStyle(host.querySelector(selector)).getPropertyValue('text-autospace');
      const result = { english: spacing('[lang="en"] span'), code: spacing('code span'), input: spacing('input'), mono: spacing('.font-mono span'),
        embedded: spacing('.md-embedded-ui p'),
        indentTrim: getComputedStyle(host.querySelector('.hd-para')).getPropertyValue('text-spacing-trim'),
        tableNumbers: getComputedStyle(host.querySelector('td')).fontVariantNumeric,
        outputNumbers: getComputedStyle(host.querySelector('output')).fontVariantNumeric,
        button: getComputedStyle(host.querySelector('button')).whiteSpace,
        hint: getComputedStyle(host.querySelector('.ui-field__hint')).textWrap };
      host.remove(); return result;
    });
    if (report.supported.autospace) {
      for (const key of ['english', 'code', 'input', 'mono', 'embedded']) assert.equal(report.defaults[key], 'no-autospace', key);
    }
    assert.notEqual(report.defaults.indentTrim, 'trim-start', 'handout keeps its native punctuation spacing');
    assert.equal(report.defaults.tableNumbers, 'tabular-nums');
    assert.equal(report.defaults.outputNumbers, 'tabular-nums');
    assert.equal(report.defaults.button, 'nowrap');
    if (report.supported.pretty) assert.equal(report.defaults.hint, 'pretty');
    const htmlOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(htmlOverflow, false, 'mobile page must not overflow horizontally');
    for (const width of [360, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await fileName.hover();
      assert.ok(await fileName.evaluate(el => el.scrollWidth > el.clientWidth ? el.title === el.textContent : !el.title));
      assert.ok(await page.locator('.resource-grid').evaluate(el => el.clientWidth <= el.parentElement.clientWidth), `text does not widen the list at ${width}px`);
      assert.ok(await fileName.evaluate(el => el.getBoundingClientRect().right <= el.closest('.resource-grid').getBoundingClientRect().right), 'label stays inside list');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ path: path.join(shots, 'library-after-mobile-dark.png'), animations: 'disabled' });
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(shots, `${phase}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase, ...report }, null, 2));
} finally {
  await browser?.close();
  await vite.close();
}
