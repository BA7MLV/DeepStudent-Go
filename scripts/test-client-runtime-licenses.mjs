import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import { dshEsm } from '../apps/web/dsh-esm.ts';

const root = path.resolve(import.meta.dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/runtime-license-test-'));
const destinations = ['web', 'api'].map(name => path.join(directory, name));
execFileSync(process.execPath, [path.join(root, 'scripts/build-client-runtime-licenses.mjs'), ...destinations], { cwd: root, stdio: 'inherit' });
const expected = fs.readFileSync(path.join(root, 'licenses/client-runtime/THIRD_PARTY_NOTICES.txt'));
for (const destination of destinations) {
  assert.deepEqual(fs.readFileSync(path.join(destination, 'THIRD_PARTY_NOTICES.txt')), expected);
  assert.ok(fs.existsSync(path.join(destination, 'client-runtime-provenance.json')));
}
for (const text of ['Shigma', 'DeepSeek', 'Meta Platforms', 'ThirdPartyNoticeText.txt', 'Apache License']) assert.ok(expected.includes(text), text);
// Exercise the actual carrier adapter and Vite's default production minifier,
// without building the application or writing its dist/public directories.
const result = await build({ configFile: false, root: path.join(root, 'apps/web'), logLevel: 'warn',
  plugins: [dshEsm(), { name: 'runtime-license-fixture',
    resolveId: id => id === 'runtime-license-fixture' ? '\0runtime-license-fixture' : undefined,
    load: id => id === '\0runtime-license-fixture' ? 'import { apply } from "@deepseek-ai/dsh-client-ui-renderer/client"; globalThis.runtimeLicenseFixture = apply;' : undefined,
  }], build: { write: false, target: 'es2020', rollupOptions: { input: 'runtime-license-fixture' } },
});
const code = result.output.filter(file => file.type === 'chunk').map(file => file.code).join('\n');
for (const text of ['@license React', 'use-sync-external-store-shim.production.js', 'use-sync-external-store-shim/with-selector.production.js', 'Copyright (c) Meta Platforms']) assert.ok(code.includes(text), `Minifier removed ${text}`);
console.log('PASS: Web/API notice packaging and production-minified renderer @license headers');
