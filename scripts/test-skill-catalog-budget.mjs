/** Adapter-only budget/lifetime tests; no production UI/scale claim. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await fs.mkdtemp('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/skill-catalog-budget-');
const output = path.join(directory, 'demand.mjs');
await build({ entryPoints: ['apps/web/src/skills/demand.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output,
  plugins: [{ name: 'catalog-ports', setup(builder) {
    const ports = {
      '../cloud/state': 'export const cloud={enabled:true,userId:"fixture"};',
      '../client/account-lifecycle': 'export const accountLifetime=()=>globalThis.catalogFixture.lifetime;',
      '../client/bootstrap': 'export const serverRuntime=async()=>globalThis.catalogFixture.runtime; export const isCurrentServerRuntime=runtime=>globalThis.catalogFixture.runtime===runtime;',
    };
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(ports, args.path) ? { path: args.path, namespace: 'catalog-ports' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'catalog-ports' }, args => ({ contents: ports[args.path], loader: 'js' }));
  } }] });
const demand = await import(pathToFileURL(output).href);
const condition = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('catalog condition did not settle');
};
function fixture(count, extra = {}) {
  const items = Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `skill-${index}`, description: '', enabled: 1, builtin: 0, updatedAt: 1, refCount: 0, ...extra }));
  const page = offset => ({ skills: items.slice(offset, offset + 50), epoch: 'fixture', version: 1, ...(offset + 50 < count ? { next: String(offset + 50) } : {}) });
  const listeners = new Set(), owners = new Set();
  const state = { refs: 0, reads: 0, firstReads: 0, live: true };
  const model = { getSnapshot: () => ({ status: 'ready', data: page(0) }), subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    acquire: () => { state.refs++; let released = false; return () => { if (!released) { released = true; state.refs--; } }; },
    refresh: () => { for (const listener of listeners) listener(); } };
  const lifetime = { current: () => state.live, assertCurrent: () => { if (!state.live) throw new Error('client_account_changed'); },
    own: cleanup => { owners.add(cleanup); return () => owners.delete(cleanup); } };
  const runtime = { skillIndex: () => model, read: async request => {
    state.reads++; if (!request.cursor) state.firstReads++;
    return { value: page(Number(request.cursor ?? 0)) };
  } };
  globalThis.catalogFixture = { runtime, lifetime };
  return { state, model, listeners, owners, runtime, invalidate: () => { state.live = false; for (const cleanup of [...owners]) cleanup(); } };
}
const evidence = { checks: [] };
try {
  let f = fixture(4096);
  assert.equal((await demand.readSkillIndex()).length, 4096);
  assert.equal(f.state.reads, 82);
  f = fixture(4097);
  await assert.rejects(demand.readSkillIndex(), /skill_catalog_budget_exceeded/);
  assert.equal(f.state.reads, 82, 'reject as soon as accumulated rows cross 4096, without fetching an unbounded tail');
  fixture(3500, { description: 'x'.repeat(2000), legacyNames: Array(16).fill('n'.repeat(64)) });
  await assert.rejects(demand.readSkillIndex(), /skill_catalog_budget_exceeded/);
  evidence.checks.push('4096-item boundary succeeds; 4097 items or >8MiB metadata reject explicitly, not a successful partial enabled set');
  f = fixture(121);
  const states = [[], []];
  const stopA = demand.observeSkillCatalog(state => states[0].push(state));
  const stopB = demand.observeSkillCatalog(state => states[1].push(state));
  await condition(() => states.every(events => events.at(-1)?.ready));
  assert.equal(f.state.refs, 1); assert.equal(f.state.reads, 2);
  assert.equal(states[0].at(-1).rows, states[1].at(-1).rows);
  stopA(); stopA(); assert.equal(f.state.refs, 1);
  stopB(); assert.equal(f.state.refs, 0); assert.equal(f.listeners.size, 0); assert.equal(f.owners.size, 0);
  const rebuilt = [];
  const stopNew = demand.observeSkillCatalog(state => rebuilt.push(state));
  assert.equal(rebuilt[0].ready, false); assert.equal(rebuilt[0].rows, undefined, 'last release drops the entire aggregated catalog');
  await condition(() => rebuilt.at(-1)?.ready);
  assert.equal(f.state.reads, 4, 'reacquire traverses catalog again even with an unchanged retained first-page version');
  assert.notEqual(rebuilt.at(-1).rows, states[0].at(-1).rows);
  f.invalidate();
  assert.equal(rebuilt.at(-1).ready, false); assert.equal(rebuilt.at(-1).rows, undefined); assert.equal(f.state.refs, 0);
  stopNew();
  evidence.checks.push('two observers share one stream and traversal; idempotent last release drops aggregate/removes callbacks; reacquire rebuilds unchanged head; terminal invalidation clears rows and releases stream');
  f = fixture(4097);
  const failed = [];
  const stopFailed = demand.observeSkillCatalog(state => failed.push(state));
  await condition(() => failed.at(-1)?.error);
  assert.match(failed.at(-1).error, /skill_catalog_budget_exceeded/);
  assert.equal(failed.some(state => state.ready || state.rows), false);
  stopFailed(); assert.equal(f.state.refs, 0);
  evidence.checks.push('shared observation publishes a retryable budget failure and no partial ready rows');
  evidence.passed = true;
  console.log('PASS skill catalog budgets:', directory, evidence.checks);
} finally { await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2)); delete globalThis.catalogFixture; }
