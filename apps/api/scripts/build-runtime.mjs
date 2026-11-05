import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
// Replace, never merge: a file removed from the bundle (e.g. retired sample
// components) must not survive in dist and be seeded into new accounts.
fs.rmSync(path.join(root, 'dist/apps/api/board-plugins'), { recursive: true, force: true });
fs.cpSync(path.join(root, 'board-plugins'), path.join(root, 'dist/apps/api/board-plugins'), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['runtime/node.ts'],
  outfile: 'dist/apps/api/runtime/node.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true, metafile: true,
});
const repository = path.resolve(root, '../..');
await build({ absWorkingDir: root, entryPoints: ['runtime/document-process.ts'], outfile: 'dist/apps/api/runtime/document-process.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
await build({ absWorkingDir: root, entryPoints: ['runtime/audio-process.ts'], outfile: 'dist/apps/api/runtime/audio-process.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
await build({ absWorkingDir: root, entryPoints: ['runtime/image-process.ts'], outfile: 'dist/apps/api/runtime/image-process.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
for (const file of Object.keys(result.metafile.inputs)) {
  const relative = path.relative(repository, path.resolve(root, file)).split(path.sep).join('/');
  if (/^(?:src\/|apps\/web\/)/.test(relative)) throw new Error(`Web dependency in API runtime: ${file}`);
}
// Match production's native loader; tsx/bundling alone can hide broken ESM
// imports in external workspace packages and otherwise break every chat task.
const runtime = await import('../dist/apps/api/runtime/node.mjs');
if (typeof runtime.executeNodeTask !== 'function') throw new Error('API task runtime did not load');
