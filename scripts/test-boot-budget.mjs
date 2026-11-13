/**
 * Startup-chunk budget gate (X-style "startup files" guardrail).
 *
 * Walks the production Vite manifest along *static* imports only (dynamic
 * imports load after first paint and are excluded), then asserts two graphs:
 *
 *   - entry graph: what a cold visitor downloads before the shell can hydrate.
 *   - first-screen graph: entry + App chunk + default route (CourseChat) —
 *     what a logged-in user opening `/` waits for. Heavy feature libraries
 *     must stay behind lazy boundaries in BOTH graphs.
 *
 * Heavy-library detection is content-based (distinctive runtime strings inside
 * the emitted chunk), not filename-based: a chunk named `messageTime-*.js`
 * once smuggled 134KB of CodeMirror past the old filename check.
 *
 * Run after `npm run build:web`: `npm run test:boot-budget`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const manifestPath = path.resolve('apps/web/dist/.vite/manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('dist/.vite/manifest.json not found — run `npm run build:web` first');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const distRoot = path.resolve('apps/web/dist');

const entryKey = Object.entries(manifest).find(([, chunk]) => chunk.isEntry && chunk.src === 'index.html')?.[0];
assert.ok(entryKey, 'index.html entry chunk missing from manifest');
// App 的 manifest 键是 Rollup 的 facade 名(`_App-…`),按 name + JS 产物找,别依赖 src 路径。
const appKey = Object.entries(manifest).find(([, chunk]) => chunk.name === 'App' && chunk.file?.endsWith('.js'))?.[0];
assert.ok(appKey, 'App chunk missing from manifest');
const chatKey = Object.entries(manifest).find(([, chunk]) => chunk.src === 'src/pages/CourseChat.tsx')?.[0];
assert.ok(chatKey, 'src/pages/CourseChat.tsx chunk missing from manifest');

/** Static-import closure of a set of manifest keys. */
const closureOf = (keys) => {
  const seen = new Set();
  const visit = (key) => {
    const chunk = manifest[key];
    if (!chunk || seen.has(key)) return;
    seen.add(key);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const key of keys) visit(key);
  return seen;
};

const entryGraph = closureOf([entryKey]);
const firstScreenGraph = closureOf([entryKey, appKey, chatKey]);
for (const css of manifest[entryKey].css ?? []) entryGraph.add(css);
// App / 默认路由自身的样式也属于首屏。
for (const key of [appKey, chatKey]) for (const css of manifest[key].css ?? []) firstScreenGraph.add(css);

const materialize = (keys) => [...keys].map((key) => {
  const file = manifest[key]?.file ?? key;
  const body = fs.readFileSync(path.join(distRoot, file));
  return { file, bytes: body.length, gzip: zlib.gzipSync(body).length, css: file.endsWith('.css'), text: body.toString('utf8') };
});

const entryFiles = materialize(entryGraph);
const screenFiles = materialize(firstScreenGraph);
const jsOf = (files) => files.filter((file) => !file.css);
const gzipOf = (files) => jsOf(files).reduce((sum, file) => sum + file.gzip, 0);

test('entry graph stays converged: few files, bounded gzip bytes', () => {
  const js = jsOf(entryFiles);
  assert.ok(js.length <= 4, `startup JS files: ${js.length} (budget 4)\n${js.map((file) => `  ${file.file} ${(file.gzip / 1024).toFixed(0)}KB gzip`).join('\n')}`);
  assert.ok(gzipOf(entryFiles) <= 640 * 1024, `startup JS gzip: ${(gzipOf(entryFiles) / 1024).toFixed(0)}KB (budget 640KB)`);
  const css = entryFiles.filter((file) => file.css);
  assert.ok(css.reduce((sum, file) => sum + file.gzip, 0) <= 200 * 1024, `startup CSS gzip too large`);
});

test('first screen (entry + App + default route) stays within budget', () => {
  const js = jsOf(screenFiles);
  assert.ok(gzipOf(screenFiles) <= FIRST_SCREEN_GZIP_BUDGET,
    `first-screen JS gzip: ${(gzipOf(screenFiles) / 1024).toFixed(0)}KB (budget ${FIRST_SCREEN_GZIP_BUDGET / 1024}KB)\n`
    + js.map((file) => `  ${file.file} ${(file.gzip / 1024).toFixed(0)}KB gzip`).join('\n'));
});

/**
 * Heavy libraries must stay behind lazy boundaries. Markers are strings that
 * only occur inside the library's runtime code (class prefixes, UMD banners,
 * license comments), so a rename of the chunk file cannot hide the leak.
 */
const HEAVY_MARKERS = {
  codemirror: ['@codemirror', 'cm-editor', '@lezer'],
  mermaid: ['mermaid.render'],
  dagre: ['dagre.esm.js.LEGAL.txt', 'dagreClusterSubgraph'],
  katex: ['KaTeX can only parse', 'katex-display'],
  cytoscape: ['cytoscape'],
  pdfjs: ['pdfjs', 'pdf.worker'],
  chart: ['chartjs', 'Chart.register'],
};

test('heavy feature libraries stay behind lazy boundaries on the first screen', () => {
  const lazyMarkers = ['katex', 'mermaid', 'pdf', 'chart', 'cytoscape', 'codemirror', 'MdEditor'];
  const screenNames = screenFiles.map((file) => file.file);
  for (const marker of lazyMarkers) {
    assert.ok(!screenNames.some((name) => name.includes(marker)), `${marker} leaked into the first-screen graph (filename)`);
  }
  for (const [library, markers] of Object.entries(HEAVY_MARKERS)) {
    for (const file of jsOf(screenFiles)) {
      for (const marker of markers) {
        assert.ok(!file.text.includes(marker), `${library} leaked into the first screen: "${marker}" found in ${file.file}`);
      }
    }
  }
});

const FIRST_SCREEN_GZIP_BUDGET = 800 * 1024;
console.log(`entry:    ${jsOf(entryFiles).length} JS files, ${(gzipOf(entryFiles) / 1024).toFixed(0)}KB gzip JS`);
console.log(`screen:   ${jsOf(screenFiles).length} JS files, ${(gzipOf(screenFiles) / 1024).toFixed(0)}KB gzip JS (entry + App + default route)`);
