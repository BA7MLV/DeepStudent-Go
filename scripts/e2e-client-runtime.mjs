import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const temporary = '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode';
const directory = fs.mkdtempSync(path.join(temporary, 'runtime-browser-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
const browserName = process.env.RUNTIME_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const proxySockets = new Set();
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createClientRuntime } from '/@fs/${path.resolve('packages/client-core/src/index.ts')}';
import { apply as renderer } from '@deepseek-ai/dsh-client-ui-renderer/client';
let scope;
const runtime = await createClientRuntime({ server: location.origin, account: 'fixture-account', scope: 'account' },
  { interactions: 'answer', transport: { fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }), streamBaseUrl: location.origin } },
  async ctx => {
    await ctx.plugin(renderer); scope = ctx;
    const absent = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
    const source = { getSnapshot: () => absent, subscribe: () => () => {} };
    ctx.slots.installScope('session', { current: source, bindingSource: () => source });
  });
const model = runtime.plugin(window.fixtureRequest);
scope.effect(() => model.acquire());
scope.slots.register({ name: 'root', inject: () => ({ hooks: { projection: model } }) }, ({ useProjection }) => {
  const snapshot = useProjection(value => value);
  return React.createElement('main', { 'data-status': snapshot.status }, ...[1, 2, 3].map(id => React.createElement('p', { key: id, 'data-placement': id }, JSON.stringify(snapshot.data))));
});
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(React.StrictMode, null, scope.slots.renderSlot('root', {})));
window.runtimeProbe = { diagnostics: runtime.diagnostics, dispose: async () => { root.unmount(); await runtime.dispose(); } };
`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'runtime-test-fixture',
      resolveId: id => id === '/__runtime-entry.js' ? '\0runtime-test-fixture' : undefined,
      load: id => id === '\0runtime-test-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__runtime') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__runtime-entry.js"></script>'); }); },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false,
      configure(proxy) {
        const track = socket => { proxySockets.add(socket); socket.once('close', () => proxySockets.delete(socket)); };
        proxy.on('open', track);
        proxy.on('proxyReqWs', (_proxyRequest, _request, socket) => track(socket));
      },
    } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });
  const context = await browser.newContext();
  const init = await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'runtime-browser-password-123' } });
  assert.equal(init.status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'runtime-browser-password-123' } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new PluginFiles(store); files.layout(owner);
  const request = { kind: 'plugin', pluginId: 'todo', instanceId: 'legacy-todo', revision: files.plugin(owner, 'todo').revision, method: 'state.read', args: {} };
  await context.addInitScript(request => { window.fixtureRequest = request; }, request);
  const page = await context.newPage(), errors = [], requests = [];
  let sockets = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.on('websocket', () => sockets++);
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()); });
  await page.goto(`${origin}/__runtime`);
  try { await page.locator('main[data-status="ready"]').waitFor({ timeout: 30000 }); }
  catch (error) { throw new Error(`${error.message}\nBrowser errors: ${errors.join('\n')}\nBody: ${await page.locator('body').innerText()}\nRuntime: ${JSON.stringify(await page.evaluate(() => window.runtimeProbe?.diagnostics()))}`); }
  assert.equal(await page.locator('[data-placement]').count(), 3);
  assert.equal(sockets, 1);
  const before = files.readState(owner, 'todo', 'legacy-todo', 'state');
  files.writeState(owner, 'todo', 'legacy-todo', 'state', { items: [{ id: 'remote', title: 'Cross-device update', done: false }] }, before.content, before.revision);
  await page.locator('[data-placement="3"]').filter({ hasText: 'Cross-device update' }).waitFor();
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(url => !url.includes('remote.mux')).length, 0, 'healthy snapshot projection uses no HTTP business reads');
  assert.ok(proxySockets.size, 'actual local proxy carries the WebSocket');
  for (const socket of proxySockets) socket.destroy();
  const updated = files.readState(owner, 'todo', 'legacy-todo', 'state');
  files.writeState(owner, 'todo', 'legacy-todo', 'state', { items: [{ id: 'reconnect', title: 'Proxy reconnect repaired', done: false }] }, updated.content, updated.revision);
  try { await page.locator('[data-placement="3"]').filter({ hasText: 'Proxy reconnect repaired' }).waitFor({ timeout: 30000 }); }
  catch (error) {
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ browser: browserName, sockets, errors, requests,
      body: await page.locator('body').innerText(), diagnostics: await page.evaluate(() => window.runtimeProbe.diagnostics()) }, null, 2));
    throw error;
  }
  assert.ok(sockets >= 2, 'proxy cut caused a real replacement carrier');
  await page.locator('main[data-status="ready"]').waitFor();
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.runtimeProbe.dispose());
  assert.equal((await page.evaluate(() => window.runtimeProbe.diagnostics())).models.length, 0);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ browser: browserName, passed: true, proxy: 'Vite http-proxy WS', sockets, errors, requests }, null, 2));
  console.log(`PASS: ${browserName} + Vite ESM + real Fastify/WS, proxy cut/reconnect, Slots shared model, three projections and disposal (${directory})`);
} finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
