import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Read-only acceptance orchestration. Each test owns a disposable database;
// all logs and failed attempts are retained. No commit, deploy or real model.
const root = process.cwd();
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/client-final-freeze-');
const previous = process.argv[2] === '--resume' ? path.resolve(process.argv[3]) : undefined;
const prior = previous ? JSON.parse(fs.readFileSync(path.join(previous, 'results.json'), 'utf8')) : undefined;
const superseded = prior?.results.filter(result => result.code !== 0) ?? [];
const results = prior?.results.filter(result => result.code === 0).map(result => ({ ...result, evidenceDirectory: result.evidenceDirectory ?? previous })) ?? [];
const identity = relatives => {
  const hash = crypto.createHash('sha256');
  const visit = filename => {
    const stat = fs.statSync(filename);
    if (stat.isDirectory()) for (const item of fs.readdirSync(filename).sort((a, b) => a.localeCompare(b))) visit(path.join(filename, item));
    else hash.update(path.relative(root, filename)).update('\0').update(fs.readFileSync(filename)).update('\0');
  };
  for (const relative of relatives) visit(path.join(root, relative));
  return hash.digest('hex');
};
const outputs = ['apps/web/dist', 'apps/api/dist', 'packages/remote-artifacts/generated'];
const sources = ['apps/web/src', 'apps/api/src', 'apps/api/runtime', 'packages/contracts/src', 'packages/client-core/src', 'packages/remote-host/src', 'packages/remote-artifacts/generated'];
const save = () => fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ directory, previous, superseded, results }, null, 2));
const run = async (name, args, env = {}) => {
  const log = fs.openSync(path.join(directory, name + '.log'), 'w');
  const startedAt = new Date().toISOString();
  const child = spawn(args[0], args.slice(1), { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', log, log] });
  const timer = setTimeout(() => child.kill('SIGTERM'), 300000);
  const result = await new Promise(resolve => { child.once('error', error => resolve({ error: String(error) })); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); fs.closeSync(log);
  results.push({ name, command: args.join(' '), env, startedAt, endedAt: new Date().toISOString(), ...result }); save();
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${name}`);
  return result.code === 0;
};
const ts = file => ['node', '--import', 'tsx', file];
console.log(directory);
if (!previous) assert.ok(await run('build', ['npm', 'run', 'build']), 'full build failed');
const before = { output: identity(outputs), source: identity(sources) };
if (previous) assert.deepEqual(before, JSON.parse(fs.readFileSync(path.join(previous, 'identities-after.json'), 'utf8')), 'cannot reuse any green test after source/output changes');
fs.writeFileSync(path.join(directory, 'identities-before.json'), JSON.stringify(before, null, 2));
const tests = [
  ['remote', ['npm', 'run', 'check:remote']],
  ['boundaries', ['npm', 'run', 'check:boundaries']],
  ['compiled-host', ['node', 'scripts/test-client-runtime-build.mjs']],
  ['licenses', ['node', 'scripts/test-client-runtime-licenses.mjs']],
  ['runtime', ts('scripts/test-client-runtime.mjs')],
  // Executor bearer/lease tests below belong to the retired architecture.
  // Preserve their files as historical evidence; exercise their business and
  // authorization contracts through the actual server producers instead.
  ['products', ts('scripts/test-plugin-learning.mjs')],
  ['server-routing-chat-artifacts', ts('scripts/test-task-executors.mjs')],
  ['server-question-permissions-cas', ts('scripts/test-server-question-extraction.mjs')],
  ['server-media-products', ts('scripts/test-server-media.mjs')],
  ['server-media-policy', ts('scripts/test-media-policy.mjs')],
  ['browser-closed-products-recovery', ts('scripts/e2e-server-task-execution.mjs')],
  ['node-edit', ts('scripts/test-node-chat-edit-e2e.mjs')],
  ['cloud', ts('scripts/test-cloud-e2e.mjs')],
  ['plugin-platform', ts('scripts/e2e-plugin-platform.mjs')],
  ['plugin-extraction', ts('scripts/e2e-plugin-extraction.mjs')],
  ['bot-model', ts('scripts/test-bot-sync.mjs')],
  ['bot-ui', ts('scripts/e2e-bot-sync.mjs')],
  ['chat-followup', ts('scripts/test-chat-followup.mjs')],
  ['session-queue', ts('scripts/e2e-session-queue.mjs')],
  ['chromium', ts('scripts/e2e-client-runtime.mjs')],
  ['webkit', ts('scripts/e2e-client-runtime.mjs'), { RUNTIME_BROWSER: 'webkit' }],
  ['pwa', ts('scripts/e2e-client-pwa.mjs')],
  ['native', ts('apps/apple/WangkeKit/Integration/native-server.mjs')],
  ['native-interactions', ts('scripts/test-native-task-interactions.mjs')],
  ['import-first', ts('scripts/e2e-library-import.mjs')],
  ['import-second', ts('scripts/e2e-library-import.mjs')],
];
// Limit browser pressure; performance is always measured alone afterward.
if (previous) {
  // Only test fixtures changed. Retain all full-suite logs; rerun the affected
  // import matrix twice, sequentially, then benchmark with no other tests alive.
  for (const test of tests.filter(test => test[0].startsWith('import-') || !results.some(result => result.name === test[0]))) {
    const index = results.findIndex(result => result.name === test[0]);
    if (index >= 0) results.splice(index, 1);
    await run(...test);
  }
} else {
  let index = 0;
  await Promise.all(Array.from({ length: 3 }, async () => { while (index < tests.length) { const test = tests[index++]; await run(...test); } }));
}
assert.ok(tests.every(test => results.some(result => result.name === test[0])), 'missing acceptance result');
if (results.every(result => result.code === 0)) await run('performance', ['node', 'scripts/benchmark-client-head.mjs', '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/client-baseline-head-4rgby508/source', '.']);
const after = { output: identity(outputs), source: identity(sources) };
fs.writeFileSync(path.join(directory, 'identities-after.json'), JSON.stringify(after, null, 2));
assert.deepEqual(after, before, 'source/output changed during final acceptance');
assert.ok(results.every(result => result.code === 0), `failures retained in ${directory}`);
console.log(`PASS final acceptance; output SHA256 ${after.output}; source SHA256 ${after.source}`);
