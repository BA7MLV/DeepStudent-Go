// 真实 PDF 阅读器适配回归，无需 API / 登录：node scripts/test-pdf-fit.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// 极小的空白 PDF，覆盖横版、竖版、旋转及混合页尺寸，不依赖外部生成器。
function pdf(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${i + 3} 0 R`).join(' ')}] >>`,
    ...pages.map(([w, h, rotate = 0]) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Rotate ${rotate} /Resources << >> >>`),
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(result.length);
    result += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = result.length;
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return `${result}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
const fixtures = {
  portrait: pdf([[600, 900], [600, 900], [600, 900]]),
  landscape: pdf([[900, 600]]),
  rotated: pdf([[600, 900, 90]]),
  mixed: pdf([[600, 900], [900, 600], [900, 600]]),
};
const server = await createServer({
  root: new URL('../apps/web', import.meta.url).pathname,
  appType: 'custom',
  plugins: [{
    name: 'pdf-fit-test-runtime',
    resolveId: id => id === '/__pdf_test_runtime.js' ? '\0pdf-test-runtime' : undefined,
    load: id => id === '\0pdf-test-runtime'
      ? "import React from 'react'; import { createRoot } from 'react-dom/client'; export { React, createRoot };"
      : undefined,
  }],
  server: { host: '127.0.0.1', port: 0, open: false },
});
server.middlewares.use('/__pdf_fixture', (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.end(fixtures[new URL(req.url, 'http://localhost').searchParams.get('kind')]);
});
server.middlewares.use('/__pdf_test', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(await server.transformIndexHtml('/__pdf_test', `<!doctype html><html><head><title>PDF fit regression</title>
    <style>body { margin: 0 } #fixture { width: 1000px; height: 600px }</style>
    </head><body><div id="fixture"></div></body></html>`));
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__pdf_test`);
  await page.evaluate(async () => {
    await import('/src/i18n/index.ts');
    const { React, createRoot } = await import('/__pdf_test_runtime.js');
    const [{ default: PdfReader }, { MaterialInkProvider }] = await Promise.all([
      import('/src/components/PdfReader.tsx'), import('/src/components/MaterialInk.tsx'),
    ]);
    const root = createRoot(document.getElementById('fixture'));
    window.mountReader = (kind, initialUnit = 1) => root.render(
      React.createElement(MaterialInkProvider, { key: crypto.randomUUID(), materialId: 'pdf-fit-test' },
        React.createElement(PdfReader, { fileUrl: `/__pdf_fixture?kind=${kind}`, initialUnit, handleRef: { current: null } })),
    );
  });
  const width = () => page.locator('.mr-page').first().evaluate(el => el.clientWidth);
  const checkFit = async (unit, aspect) => {
    await page.waitForFunction(({ unit, aspect }) => {
      const scroll = document.querySelector('.mr-scroll');
      const el = document.querySelector(`[data-page="${unit}"]`);
      if (!scroll || !el?.querySelector('canvas')?.width) return false;
      const cs = getComputedStyle(scroll);
      const w = scroll.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = scroll.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      return Math.abs(el.clientWidth - Math.floor(Math.min(w, h / aspect))) <= 1
        && Math.abs(el.clientHeight / el.clientWidth - aspect) < 0.01
        && el.clientHeight <= h + 1 && el.clientWidth <= w + 1;
    }, { unit, aspect });
    assert.equal(await page.getByTestId('reader-zoom-fit').getAttribute('aria-pressed'), 'true');
  };
  for (const [kind, aspect, initialUnit] of [
    ['portrait', 1.5, 1], ['landscape', 2 / 3, 1], ['rotated', 2 / 3, 1], ['mixed', 2 / 3, 2],
  ]) {
    await page.evaluate(({ kind, initialUnit }) => window.mountReader(kind, initialUnit), { kind, initialUnit });
    await checkFit(initialUnit, aspect);
    console.log(`PASS ${kind}: 打开时按真实页面比例适配整页`);
  }

  await page.evaluate(() => window.mountReader('portrait'));
  await checkFit(1, 1.5);
  const initialWidth = await width();
  await page.$eval('#fixture', el => { el.style.height = '450px'; });
  await checkFit(1, 1.5);
  assert.ok(await width() < initialWidth, '高度缩小时自动重新适配');
  const fitWidth = await width();
  await page.getByTestId('reader-zoom-out').click();
  assert.ok(await width() < fitWidth, '低于 50% 的适配比例仍然可以缩小');
  await page.getByTestId('reader-zoom-in').click();
  const manualWidth = await width();
  await page.$eval('#fixture', el => { el.style.height = '750px'; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await width(), manualWidth, '手动缩放不会被高度变化覆盖');
  await page.getByTestId('reader-zoom-fit').click();
  await checkFit(1, 1.5);
  await page.$eval('#fixture', el => { el.style.width = '360px'; });
  await checkFit(1, 1.5);
  console.log('PASS 高度 / 窄屏变化、手动缩放、恢复自动适配');
  assert.deepEqual(errors, [], '浏览器无未处理异常');
} finally {
  await browser?.close();
  await server.close();
}
