import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'vite';

test('PWA precache and PDF assets follow relative/absolute output and custom manifest paths', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-build-directory-')));
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/entry.js"></script>');
    fs.writeFileSync(path.join(root, 'entry.js'), 'console.info("isolated PWA build fixture");');
    for (const [outDir, manifest] of [
      ['relative-output', true],
      [path.join(root, 'absolute-output'), 'metadata/manifest.json'],
    ]) {
      await build({
        configFile: path.resolve('apps/web/vite.config.ts'), root, publicDir: false,
        logLevel: 'silent', build: { outDir, manifest },
      });
      const output = path.resolve(root, outDir);
      const graph = JSON.parse(fs.readFileSync(path.join(output, typeof manifest === 'string' ? manifest : '.vite/manifest.json'), 'utf8'));
      const entry = Object.values(graph).find(chunk => chunk.isEntry);
      const sw = fs.readFileSync(path.join(output, 'sw.js'), 'utf8');
      assert.ok(entry);
      assert.ok(sw.includes(entry.file), `${outDir}: current entry must be precached, not an old default dist entry`);
      for (const sub of ['cmaps', 'standard_fonts']) {
        const files = fs.readdirSync(path.join(output, 'pdfjs', sub));
        assert.ok(files.some(file => /\.(bcmap|pfb|ttf)$/.test(file)), `${outDir}: PDF ${sub} must be copied inside the build output`);
        assert.ok(files.some(file => /LICENSE/i.test(file)), `${outDir}: PDF asset licenses must be preserved`);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
