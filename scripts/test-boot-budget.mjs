/**
 * Startup-chunk budget gate (X-style "startup files" guardrail).
 *
 * Walks the production Vite manifest from the HTML entry through *static*
 * imports only (dynamic imports load after first paint and are excluded),
 * then asserts the cold-start graph stays converged:
 *
 *   - file count: the browser cannot hydrate until every file in the entry's
 *     static import graph has arrived; each file is a potential round trip.
 *   - gzip bytes: startup cost on a slow connection.
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

const entry = Object.values(manifest).find((chunk) => chunk.isEntry && chunk.src === 'index.html');
assert.ok(entry, 'index.html entry chunk missing from manifest');

const startup = new Set();
const visit = (key) => {
  const chunk = manifest[key];
  if (!chunk || startup.has(key)) return;
  startup.add(key);
  for (const imported of chunk.imports ?? []) visit(imported);
};
visit('index.html');
for (const css of entry.css ?? []) startup.add(css);

const files = [...startup].map((key) => {
  const file = manifest[key]?.file ?? key;
  const body = fs.readFileSync(path.join(distRoot, file));
  return { file, bytes: body.length, gzip: zlib.gzipSync(body).length, css: file.endsWith('.css') };
});

const jsFiles = files.filter((file) => !file.css);
const jsGzip = jsFiles.reduce((sum, file) => sum + file.gzip, 0);
const cssGzip = files.filter((file) => file.css).reduce((sum, file) => sum + file.gzip, 0);

test('startup graph stays converged: few files, bounded gzip bytes', () => {
  assert.ok(jsFiles.length <= 4, `startup JS files: ${jsFiles.length} (budget 4)\n${jsFiles.map((file) => `  ${file.file} ${(file.gzip / 1024).toFixed(0)}KB gzip`).join('\n')}`);
  assert.ok(jsGzip <= 640 * 1024, `startup JS gzip: ${(jsGzip / 1024).toFixed(0)}KB (budget 640KB)`);
  assert.ok(cssGzip <= 200 * 1024, `startup CSS gzip: ${(cssGzip / 1024).toFixed(0)}KB (budget 200KB)`);
});

test('heavy feature libraries stay behind lazy boundaries at startup', () => {
  const lazyMarkers = ['katex', 'mermaid', 'pdf', 'chart', 'cytoscape', 'codemirror', 'MdEditor'];
  const startupNames = jsFiles.map((file) => file.file);
  for (const marker of lazyMarkers) {
    assert.ok(!startupNames.some((name) => name.includes(marker)), `${marker} leaked into the startup graph`);
  }
});

console.log(`startup: ${jsFiles.length} JS files, ${(jsGzip / 1024).toFixed(0)}KB gzip JS, ${(cssGzip / 1024).toFixed(0)}KB gzip CSS`);
