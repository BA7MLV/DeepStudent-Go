import assert from 'node:assert/strict';
import test from 'node:test';
import { shellPrecache } from '../apps/web/pwa-precache.ts';

test('precache follows only static entry edges, includes CSS/assets and handles shared cycles', () => {
  const graph = {
    'index.html': { file: 'assets/index.js', isEntry: true, imports: ['shared'], dynamicImports: ['pdf'], css: ['assets/index.css'] },
    shared: { file: 'assets/shared.js', imports: ['index.html'], assets: ['assets/logo.svg'] },
    pdf: { file: 'assets/pdf.js', imports: ['mermaid'], css: ['assets/pdf.css'] },
    mermaid: { file: 'assets/mermaid.js' },
  };
  const entries = ['assets/index.js', 'assets/shared.js', 'assets/index.css', 'assets/logo.svg', 'assets/pdf.js', 'assets/pdf.css', 'assets/mermaid.js', 'icon.svg', 'config.js', 'index.html'].map(url => ({ url, size: 100, revision: 'fixture' }));
  assert.deepEqual(shellPrecache(entries, graph).manifest.map(row => row.url), ['assets/index.js', 'assets/shared.js', 'assets/index.css', 'assets/logo.svg', 'icon.svg']);
});
test('missing graph/dependency and shell budget fail the build, not silently remove offline dependencies', () => {
  assert.throws(() => shellPrecache([], {}), /missing_entry/);
  assert.throws(() => shellPrecache([], { entry: { file: 'entry.js', isEntry: true, imports: ['missing'] } }), /missing_static_dependency/);
  assert.throws(() => shellPrecache([{ url: 'entry.js', size: 3 * 1024 * 1024 + 1 }], { entry: { file: 'entry.js', isEntry: true } }), /shell_bytes_limit/);
});
