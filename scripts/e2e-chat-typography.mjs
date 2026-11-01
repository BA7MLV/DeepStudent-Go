import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// Real Chat renderer, isolated browser storage, no account or AI requests.
const engine = process.env.BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine));
const shots = path.resolve('test-results/chat-typography', engine);
await mkdir(shots, { recursive: true });
const vite = await createServer({ root: path.resolve('apps/web'), server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await vite.listen();
  browser = await (engine === 'webkit' ? webkit.launch({ headless: true }) : chromium.launch({ channel: 'chrome', headless: true }));
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  await page.waitForFunction(() => document.querySelector('textarea.course-chat__input')?.disabled === false);
  await page.evaluate(async () => {
    const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === '/src/store/courseChat.ts');
    const { useCourseChat } = await import(entry.name);
    const id = 987655;
    useCourseChat.setState({ ready: true, loaded: true, activeId: id,
      sessions: [{ id, title: 'Chat 稳定排版回归', createdAt: Date.now(), updatedAt: Date.now() }], messages: [] });
    window.renderTypographyAnswer = (content, streaming) => useCourseChat.setState({ messages: [
      { key: 'typography-user', role: 'user', content: '保留我输入的换行：\n第二行 const 中文PDF12 = 1;', createdAt: 1 },
      { key: 'typography-answer', role: 'ai', content, streaming, processPhase: 'answering', createdAt: 2 },
    ] });
  });
  const render = async (content, streaming) => {
    await page.evaluate(({ content, streaming }) => window.renderTypographyAnswer(content, streaming), { content, streaming });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const prose = page.locator('.course-chat__bubble--ai .x-markdown:not(.reasoning-markdown)').first();
  const title = 'Building a clearer understanding of complex learning materials together with readable examples and useful revision notes';
  const paragraph = 'A useful study note connects the central idea with examples you can revisit. Keep the explanation readable so that the final sentence feels complete rather than leaving one small word behind. This matters. '.repeat(3).trim();
  const literal = 'const 中文PDF12 = "keep  two spaces";\n    const token = "' + 'x'.repeat(220) + '";';
  const longUrl = 'https://example.com/reading/' + 'continuous'.repeat(35);
  const blocks = [
    `## ${title}`, paragraph,
    '使用DeepStudent整理PDF和Markdown资料，结合AI复习第12章。保留中文标点禁则，不把正文当作展示标题。',
    '- First item keeps ordinary wrapping when new words arrive.\n- 第二项包含English和12个数字。',
    '> A quoted explanation also keeps ordinary wrapping.',
    '`const 中文PDF12 = "literal";`',
    '```js\n' + literal + '\n```',
    longUrl,
    '| 项目 | 数值 | 说明 |\n| --- | ---: | --- |\n| PDF12 | 1234 | 中文与English混排 |\n| Notes | 5678 | ' + 'longidentifier'.repeat(10) + ' |\n',
    '公式：$x_i^2$。',
  ];
  const full = blocks.join('\n\n');
  const metrics = async () => prose.evaluate(root => {
    const origin = root.getBoundingClientRect();
    return [...root.querySelectorAll('h2, p, li, blockquote')]
      .filter(el => !el.closest('.md-embedded-ui')).map(el => {
        const rect = el.getBoundingClientRect();
        return { tag: el.tagName, text: el.textContent, x: rect.x - origin.x, y: rect.y - origin.y,
          width: rect.width, height: rect.height, wrap: getComputedStyle(el).textWrapStyle };
      });
  });
  const firstGlyphs = async selector => prose.locator(selector).first().evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const origin = el.getBoundingClientRect();
    const result = [];
    for (let node = walker.nextNode(); node && result.length < 10; node = walker.nextNode()) {
      for (let i = 0; i < node.length && result.length < 10; i++) {
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        result.push({ char: node.textContent[i], x: rect.x - origin.x, y: rect.y - origin.y });
      }
    }
    return result;
  });
  const report = [];
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
      await render(`## ${title.slice(0, 75)}`, true);
      const headingStart = await firstGlyphs('h2');
      for (let end = 85; end < title.length; end += 10) await render(`## ${title.slice(0, end)}`, true);
      await render(blocks[0], true);
      assert.deepEqual(await firstGlyphs('h2'), headingStart, 'appending heading words does not rebalance its start');

      await render(`${blocks[0]}\n\n${paragraph.slice(0, 220)}`, true);
      const paragraphStart = await firstGlyphs('p');
      for (let end = 260; end < paragraph.length; end += 40) await render(`${blocks[0]}\n\n${paragraph.slice(0, end)}`, true);
      await render(`${blocks[0]}\n\n${paragraph}`, true);
      assert.deepEqual(await firstGlyphs('p'), paragraphStart, 'appending prose does not reflow earlier lines');
      // Add real Markdown features progressively, including complete table rows.
      for (let count = 3; count <= blocks.length; count++) {
        if (count === 7) {
          for (const end of [30, 100, literal.length]) {
            const prefix = literal.slice(0, end);
            await render(blocks.slice(0, 6).join('\n\n') + '\n\n```js\n' + prefix, true);
            assert.equal((await prose.locator('.code-block__source').textContent()).trimEnd(), prefix.trimEnd());
          }
        }
        await render(blocks.slice(0, count).join('\n\n'), true);
      }
      await prose.locator('.katex').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const live = await metrics();
      assert.ok(live.length > 6);
      assert.ok(live.every(item => item.wrap === 'auto'), 'all message prose uses ordinary wrapping');
      const code = prose.locator('.code-block__source').first();
      assert.equal((await code.textContent()).trimEnd(), literal);
      assert.equal(await code.evaluate(el => getComputedStyle(el).whiteSpace), 'pre');
      assert.equal(await code.evaluate(el => getComputedStyle(el).getPropertyValue('text-autospace')), 'no-autospace');
      assert.equal(await prose.locator('.md-table-scroll').count(), 1);
      assert.equal(await prose.locator('tbody tr').count(), 2);
      assert.equal(await prose.locator('math').count(), 1);
      const lineBreaks = await page.locator('.course-chat__user-text').innerText();
      assert.match(lineBreaks, /换行：\n第二行/);

      await render(full, false);
      const completed = await metrics();
      // Table layout has its own stream/final contract; compare prose separately.
      const nonTable = list => list.filter(item => !item.text.startsWith('公式：'));
      assert.deepEqual(nonTable(completed), nonTable(live), 'finishing the answer does not switch prose layout');
      assert.equal(await prose.locator('tbody tr').count(), 2);
      assert.equal(await prose.locator('a').filter({ hasText: longUrl }).count(), 1);
      const geometry = await prose.evaluate(el => {
        const root = el.getBoundingClientRect();
        return { pageOverflow: document.documentElement.scrollWidth > innerWidth,
          messageOverflow: el.scrollWidth > el.clientWidth + 1,
          headingFits: el.querySelector('h2').getBoundingClientRect().right <= root.right + 1,
          tableFits: el.querySelector('.md-table-scroll').getBoundingClientRect().right <= root.right + 1,
          codeFits: el.querySelector('.code-block__source').getBoundingClientRect().right <= root.right + 1,
          literalScrolls: el.querySelector('.code-block__source').scrollWidth > el.querySelector('.code-block__source').clientWidth,
          trim: getComputedStyle(el.querySelector('p')).getPropertyValue('text-spacing-trim'),
        };
      });
      assert.equal(geometry.pageOverflow, false);
      assert.equal(geometry.messageOverflow, false);
      for (const key of ['headingFits', 'tableFits', 'codeFits', 'literalScrolls']) assert.equal(geometry[key], true, key);
      assert.notEqual(geometry.trim, 'trim-start');
      report.push({ width, dark, stableHeading: true, stableParagraph: true, stableCompletion: true, ...geometry });
      if (width === 390) {
        await page.locator('.course-chat__messages').evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: path.join(shots, `chat-${dark ? 'dark' : 'light'}-mobile.png`), animations: 'disabled' });
      }
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(shots, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS (${engine}): ${report.length} viewport/theme cases; incremental heading/prose, completion, literal code, long URL, table, math and user line breaks.`);
} finally {
  await browser?.close();
  await vite.close();
}
