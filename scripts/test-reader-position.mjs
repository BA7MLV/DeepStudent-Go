// 真实阅读器回归：node scripts/test-reader-position.mjs（无需 API / 登录）。
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { Document, Packer, Paragraph } from 'docx';

const text = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 段正文。${'用于验证滚动后的实际阅读位置。'.repeat(16)}`);
const word = [...await Packer.toBuffer(new Document({ sections: [{ children: text.map(t => new Paragraph(t)) }] }))];
const server = await createServer({
  root: new URL('../apps/web', import.meta.url).pathname,
  appType: 'custom',
  plugins: [{
    name: 'reader-test-runtime',
    resolveId: id => id === '/__reader_test_runtime.js' ? '\0reader-test-runtime' : undefined,
    load: id => id === '\0reader-test-runtime'
      ? "import React from 'react'; import { createRoot } from 'react-dom/client'; export { React, createRoot };"
      : undefined,
  }],
  server: { host: '127.0.0.1', port: 0, open: false },
});
server.middlewares.use('/__reader_test', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(await server.transformIndexHtml('/__reader_test', `<!doctype html><html><head><title>Reader position regression</title>
    <style>body { margin: 0 } #fixture { width: 1000px; height: 420px }
    .mr-md__block, .mr-html__block { min-height: 160px; margin-bottom: 60px !important }
    </style></head><body><div id="fixture"></div></body></html>`));
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__reader_test`);
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/__reader_test_runtime.js');
    const [{ default: MdReader }, { default: DocxReader }, { default: HtmlReader }, { MaterialInkProvider }] = await Promise.all([
      import('/src/components/MdReader.tsx'), import('/src/components/DocxReader.tsx'),
      import('/src/components/HtmlReader.tsx'), import('/src/components/MaterialInk.tsx'),
    ]);
    const root = createRoot(document.getElementById('fixture'));
    window.mountReader = ({ kind, initialUnit = 1, text, word, short = false }) => {
      const materialId = `${kind}-${crypto.randomUUID()}`;
      window.unitChanges = [];
      window.readerHandle = { current: null };
      const props = {
        materialId, initialUnit, handleRef: window.readerHandle,
        onUnitChange: (unit, total) => window.unitChanges.push({ unit, total }),
      };
      const paragraphs = short ? ['第一段', '第二段', '第三段'] : text;
      if (kind === 'md') props.blob = new Blob([paragraphs.join('\n\n')]);
      else if (kind === 'docx') props.blob = new Blob([new Uint8Array(word)]);
      else {
        props.blob = new Blob([`<!doctype html><style>p { min-height: ${short ? 0 : 160}px; margin: ${short ? 0 : 60}px 0 }</style>${paragraphs.map(t => `<p>${t}</p>`).join('')}`]);
        props.initialView = kind === 'raw' ? 'raw' : 'blocks';
        props.onViewChange = () => {};
      }
      root.render(React.createElement(MaterialInkProvider, { key: materialId, materialId },
        React.createElement(kind === 'md' ? MdReader : kind === 'docx' ? DocxReader : HtmlReader, props)));
    };
  });

  const waitUnit = async (unit, total = 14) => {
    await page.waitForFunction(({ unit, total }) => {
      const latest = window.unitChanges.at(-1);
      return latest?.unit === unit && latest.total === total;
    },
    { unit, total }, { timeout: 10000 });
    assert.equal(await page.getByTestId('reader-page-indicator').count(), 0, '不再显示顶部段号');
  };
  const scrollUnit = async (unit) => page.evaluate(unit => {
    const frame = document.querySelector('iframe');
    const root = frame ? frame.contentDocument.scrollingElement : document.querySelector('.mr-scroll');
    const el = frame ? frame.contentDocument.querySelector(`[data-mr-unit="${unit}"]`) : root.querySelector(`[data-unit="${unit}"]`);
    const top = frame ? 0 : root.getBoundingClientRect().top + root.clientTop;
    root.scrollTop += el.getBoundingClientRect().top - top - 12;
  }, unit);
  const scrollEdge = async (bottom) => page.evaluate(bottom => {
    const frame = document.querySelector('iframe');
    const root = frame ? frame.contentDocument.scrollingElement : document.querySelector('.mr-scroll');
    root.scrollTop = bottom ? root.scrollHeight : 0;
  }, bottom);

  for (const kind of ['md', 'docx', 'blocks', 'raw']) {
    await page.evaluate(args => window.mountReader(args), { kind, text, word, initialUnit: 7 });
    await waitUnit(7);
    if (kind === 'raw') {
      await page.waitForFunction(() => {
        const doc = document.querySelector('iframe')?.contentDocument;
        return doc?.readyState === 'complete' && doc.querySelector('[data-mr-unit]');
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    assert.equal(await page.evaluate(() => window.unitChanges[0]?.unit), 7, `${kind}: 首次上报不应覆盖断点为 1`);
    await scrollUnit(10);
    await waitUnit(10);
    await scrollUnit(3);
    await waitUnit(3);
    await page.evaluate(() => new Promise(resolve => {
      const target = document.querySelector('iframe')?.contentDocument ?? document.querySelector('.mr-scroll');
      target.addEventListener('scrollend', resolve, { once: true });
      window.readerHandle.current.scrollToUnit(6);
    }));
    await waitUnit(6);
    await scrollEdge(true);
    await waitUnit(14);
    await scrollEdge(false);
    await waitUnit(1);
    // 宽矮面板和窄高面板均不能依赖按「宽度」解析的 rootMargin 百分比。
    await page.$eval('#fixture', el => { el.style.width = '360px'; el.style.height = '700px'; });
    await scrollUnit(8);
    await waitUnit(8);
    await scrollEdge(true);
    await waitUnit(14);
    await page.$eval('#fixture', el => { el.style.width = '1000px'; el.style.height = '420px'; });
    console.log(`PASS ${kind}: 断点、快速双向滚动、引用跳转、末段、回顶部、宽窄面板`);
  }

  // 短 HTML：显式引用目标不因切换视图时没有滚动条而退回第 1 段。
  await page.addStyleTag({ content: '.mr-html__block { min-height: 0; margin-bottom: 0 !important }' });
  await page.$eval('#fixture', el => { el.style.height = '850px'; });
  await page.evaluate(args => window.mountReader(args), { kind: 'raw', text, word, initialUnit: 3, short: true });
  await waitUnit(3, 3);
  await page.getByTestId('html-view-blocks').click();
  await page.locator('.mr-html__block').first().waitFor();
  await waitUnit(3, 3);
  await page.getByTestId('html-view-raw').click();
  await page.locator('iframe').waitFor();
  await waitUnit(3, 3);
  assert.ok((await page.evaluate(() => window.unitChanges)).every(({ unit }) => unit === 3));
  console.log('PASS 短 HTML：切换原样 / 分段视图不重置段号');

  assert.deepEqual(errors, [], '浏览器无未处理异常');
} finally {
  await browser?.close();
  await server.close();
}
