import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

// Execute the remaining shipped HTML cache. Business subscriptions are now
// covered by real HTTP/WS Models and production-component browser regressions.
const source = fs.readFileSync(new URL('../apps/web/src/plugins/shared.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const events = new Map(), timers = new Map(), storage = new Map([['plugin-draft:test', 'draft'], ['other', 'keep']]);
let nextTimer = 0, requests = 0, resolveRequest;
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, console, Date, Map, Set, Promise, JSON, Error,
  require: () => ({ readRendererPluginAsset: () => { requests++; return new Promise(resolve => { resolveRequest = resolve; }); } }),
  window: { addEventListener: (name, callback) => events.set(name, callback) },
  document: { hidden: false },
  sessionStorage: { ...Object.fromEntries(storage), removeItem(key) { storage.delete(key); delete this[key]; } },
  setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id),
});
vm.runInContext(code, context);
const { pluginRead } = module.exports;
assert.equal('subscribePluginRead' in module.exports, false, 'legacy polling subscription must not return');
for (const file of ['FlashcardsView', 'MaterialToolsView', 'PracticeView', 'ReviewView']) {
  const view = fs.readFileSync(new URL(`../apps/web/src/plugins/learning/${file}.tsx`, import.meta.url), 'utf8');
  assert.doesNotMatch(view, /subscribePluginRead|setInterval/);
}
const first = pluginRead('/same'), second = pluginRead('/same');
assert.equal(first, second); assert.equal(requests, 1, 'same-path HTML reads share one in-flight request');
events.get('wangke:bot-session-ended')();
assert.equal(timers.size, 0); assert.equal(storage.has('plugin-draft:test'), false); assert.equal(storage.has('other'), true);
resolveRequest({ secret: 'old-account-state' });
await assert.rejects(first, /plugin_session_changed/);
const next = pluginRead('/same'); assert.equal(requests, 2);
resolveRequest({ fresh: true }); assert.equal((await next).fresh, true);
assert.equal(timers.size, 0, 'HTML reads must not install a business polling timer');
console.log('Plugin HTML cache passed: shared in-flight read, account disposal, draft cleanup, rejection of late old-account HTML and no legacy learning polling API. Business subscription lifecycle is covered by real Model/production-component tests.');
