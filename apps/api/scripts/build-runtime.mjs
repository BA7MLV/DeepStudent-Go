import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
fs.cpSync(path.join(root, 'board-plugins'), path.join(root, 'dist/apps/api/board-plugins'), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['runtime/node.ts'],
  outfile: 'dist/apps/api/runtime/node.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true, metafile: true,
});
const repository = path.resolve(root, '../..');
for (const file of Object.keys(result.metafile.inputs)) {
  const relative = path.relative(repository, path.resolve(root, file)).split(path.sep).join('/');
  if (/^(?:src\/|apps\/web\/)/.test(relative)) throw new Error(`Web dependency in API runtime: ${file}`);
}
