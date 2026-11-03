import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

// Execute the shipped subscription/cache implementation, not a parallel mock.
const source = fs.readFileSync(new URL('../apps/web/src/plugins/shared.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const events = new Map(), timers = new Map(), storage = new Map([['plugin-draft:test', 'draft'], ['other', 'keep']]);
let nextTimer = 0, requests = 0, resolveRequest;
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, console, Date, Map, Set, Promise, JSON, Error,
  require: () => ({ request: () => { requests++; return new Promise(resolve => { resolveRequest = resolve; }); } }),
  window: { addEventListener: (name, callback) => events.set(name, callback) },
  document: { hidden: false },
  sessionStorage: { ...Object.fromEntries(storage), removeItem(key) { storage.delete(key); delete this[key]; } },
  setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id),
});
vm.runInContext(code, context);
const { pluginRpc, subscribePluginRead } = module.exports;
const settle = () => new Promise(resolve => setImmediate(resolve));
let reads = 0; const valuesA = [], valuesB = [];
const read = async () => ({ revision: ++reads });
const offA = subscribePluginRead('same-instance', read, value => valuesA.push(value));
const offB = subscribePluginRead('same-instance', read, value => valuesB.push(value));
await settle();
assert.equal(reads, 1); assert.equal(timers.size, 1); assert.equal(valuesA.length, 1); assert.equal(valuesB.length, 1);
offA(); assert.equal(timers.size, 1);
const [id, tick] = [...timers][0]; timers.delete(id); await tick(); await settle();
assert.equal(reads, 2); assert.equal(valuesA.length, 1); assert.equal(valuesB.length, 2);
offB(); assert.equal(timers.size, 0);
const offC = subscribePluginRead('same-instance', read, () => {}); await settle();
assert.equal(reads, 3); assert.equal(timers.size, 1);
const first = pluginRpc('/same', 1, 'state.read', {}), second = pluginRpc('/same', 1, 'state.read', {});
assert.equal(first, second); assert.equal(requests, 1, 'same-instance mounts share one in-flight read');
events.get('wangke:bot-session-ended')();
assert.equal(timers.size, 0); assert.equal(storage.has('plugin-draft:test'), false); assert.equal(storage.has('other'), true);
resolveRequest({ secret: 'old-account-state' });
await assert.rejects(first, /plugin_session_changed/);
offC();
const next = pluginRpc('/same', 1, 'state.read', {}); assert.equal(requests, 2);
resolveRequest({ fresh: true }); assert.equal((await next).fresh, true);
console.log('Shipped plugin shared state passed: multi-mount single poll/cache, independent listener release, final unmount cleanup, remount, account-switch disposal, draft cleanup and rejection of late old-account reads.');
