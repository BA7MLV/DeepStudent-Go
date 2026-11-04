import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectSource } from './check-boundaries.mjs';

// Exercise the same AST rules used by the repository build gate.
const root = 'apps/web/src/plugins';
const files = fs.readdirSync(root, { recursive: true }).filter(name => /\.[jt]sx?$/.test(name));
function assertViewBoundary(source, name) {
  const imports = source.split('\n').filter(line => /\bimport\b/.test(line) && !/\bimport\s+type\b/.test(line)).join('\n');
  assert.doesNotMatch(imports, /(?:api\/serverClient|client\/(?:bootstrap|plugins|plugin-projection)|store\/db|@deepseek-ai\/cordis)/, name);
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket|EventSource|useSyncExternalStore)\s*\(/, name);
}
for (const name of files) {
  const source = fs.readFileSync(path.join(root, name), 'utf8');
  if (name.endsWith('.tsx')) assertViewBoundary(source, name);
  assert.doesNotMatch(source, /\buseSyncExternalStore\s*\(/, `${name}: only renderer may bridge bare sources`);
  assert.doesNotMatch(source, /from\s+['"][^'"]*api\/serverClient['"]/, `${name}: transport boundary`);
}
for (const bad of ["import {request} from '../api/serverClient';", 'fetch("/api")', 'new WebSocket("wss://bad")', 'useSyncExternalStore(subscribe,getSnapshot)']) {
  assert.throws(() => assertViewBoundary(bad, 'negative fixture'));
  assert.ok(inspectSource(path.resolve(root, 'negative.tsx'), bad).length, bad);
}
for (const bad of ["import { Context } from '@deepseek-ai/cordis';", "import {\n request\n} from '../api/serverClient';", 'React.useSyncExternalStore(subscribe,getSnapshot)', 'window.fetch("/api")']) {
  assert.ok(inspectSource(path.resolve(root, 'negative.tsx'), bad).length, bad);
}
for (const good of ["import type { Context } from '@deepseek-ai/cordis';", "import { type Context } from '@deepseek-ai/cordis';"]) {
  assert.deepEqual(inspectSource(path.resolve(root, 'positive.tsx'), good), [], good);
}
console.log('PASS plugin renderer boundaries and transport/source negative fixtures');
