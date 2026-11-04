import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Isolate the production view's deadline clock. Domain I/O is deliberately a
// fixture here; real query authorization/notifications have separate tests.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '/src/i18n';
import ReviewView from '/src/plugins/learning/ReviewView.tsx';
window.clockProbe = { observations: 0, releases: 0, calls: 0 };
const sources = new Map();
function useProjection(queries) {
  const key = JSON.stringify(queries);
  if (!sources.has(key)) {
    const asOf = Date.now() + 3600000;
    const snapshot = { status: 'ready', data: { result: queries[0].method === 'learning.materials' ? { materials: [{ id: 'material-a', name: 'Material A' }] } : {
      asOf, cards: { total: 0, pending: 0, kept: 0 }, due: 0, completed: 0, notebookMaterialId: null,
      questions: [{ id: 'future-question', stem: 'Deadline question', status: 'learning', due: new Date(asOf + 1200).toISOString(), dueNow: false, attempts: 0 }],
    } } };
    sources.set(key, { getSnapshot: () => snapshot, subscribe: () => { clockProbe.observations++; let active = true; return () => { if (active) { active = false; clockProbe.releases++; } }; } });
  }
  const source = sources.get(key);
  return React.useSyncExternalStore(source.subscribe, source.getSnapshot);
}
const root = createRoot(document.getElementById('root'));
window.unmountReview = () => root.unmount();
root.render(React.createElement(React.StrictMode, null, React.createElement(BrowserRouter, null,
  React.createElement(ReviewView, { plugin: { id: 'review', revision: 1 }, instance: { id: 'review-clock', scope: { kind: 'material', id: 'material-a' } },
     placement: { id: 'clock-placement' }, context: {}, useProjection, call: async () => { clockProbe.calls++; throw new Error('unexpected_unary'); } }))));
`;
const web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
  plugins: [{ name: 'review-clock-fixture', enforce: 'pre',
    resolveId(id, importer) {
      if (id === '/__review-clock.js') return '\0review-clock';
    },
    load: id => id === '\0review-clock' ? fixture : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== '/__review-clock') return next();
      res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__review-clock.js"></script>');
    }); },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
let browser;
try {
  await web.listen(); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${web.resolvedUrls.local[0]}__review-clock`);
  await page.getByText('到期 0 题 · 已掌握 0 题 · 共 1 道错题', { exact: true }).waitFor();
  const before = await page.evaluate(() => clockProbe.observations);
  await page.getByText('到期 1 题 · 已掌握 0 题 · 共 1 道错题', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => clockProbe.observations), before, 'crossing an FSRS deadline never reopens a business query');
  assert.equal(await page.evaluate(() => clockProbe.calls), 0);
  await page.evaluate(() => unmountReview());
  assert.equal(await page.evaluate(() => clockProbe.releases), before, 'StrictMode subscriptions are released on unmount');
  assert.deepEqual(errors, []);
  console.log('PASS: production ReviewView uses server-anchored FSRS deadlines without polling or trusting browser wall-clock time, and releases observations');
} finally { await browser?.close(); await web.close(); }
