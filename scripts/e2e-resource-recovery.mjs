import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/resource-browser-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let browser, web, store, page;
const errors = [];
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import '/src/i18n';
import {cloud} from '/src/cloud/state.ts';import {db,useCloudDatabase} from '/src/store/db.ts';
import {serverRuntime,disposeServerRuntime} from '/src/client/bootstrap.ts';
import {resourceCommand,uploadResource,recordReadingPosition,recordPlayback,readResources} from '/src/client/resources.ts';
import {startResourceCommands,flushResourceCommands,resumeResourceCommands,useResourceCommands} from '/src/client/resource-commands.ts';
import {serverClient} from '/src/api/serverClient.ts';
import Notice from '/src/cloud/ResourceSaveNotice.tsx';import Recovery from '/src/cloud/ResourceRecovery.tsx';
cloud.enabled=true;cloud.userId=window.fixtureOwner;useCloudDatabase(cloud.userId);await db.open();await serverRuntime(cloud.userId);startResourceCommands();
function Probe(){const [open,setOpen]=useState(false);return React.createElement(React.Fragment,null,React.createElement(Notice),React.createElement('button',{onClick:()=>setOpen(!open)},'Toggle recovery'),open?React.createElement(Recovery):null)}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Probe)));
window.probe={resource:resourceCommand,upload:(id)=>uploadResource(id,'retained-upload.txt',new Blob(['original upload bytes'])),reading:recordReadingPosition,playback:recordPlayback,
flush:flushResourceCommands,resume:resumeResourceCommands,resources:readResources,text:serverClient.projectText,
pending:()=>db.table('_cloudMeta').where('id').startsWith('resource-command:').toArray(),all:()=>db.table('_cloudMeta').toArray(),issues:()=>useResourceCommands.getState(),
async seed(row){await db.table('_cloudMeta').put(row)},dispose(){disposeServerRuntime()},restart(){startResourceCommands()},
};document.body.dataset.ready='true';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'cache'),
    plugins: [{ name: 'resource-recovery-fixture', resolveId: id => id === '/__resource.tsx' ? '\0resource.tsx' : undefined, load: id => id === '\0resource.tsx' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__resources') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__resource.tsx"></script>'); }); } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); browser = await chromium.launch({ headless: true });
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  const context = await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'resource-recovery-browser-123' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'resource-recovery-browser-123' } });
  const owner = (await login.json()).user.id;
  await context.addInitScript(owner => { window.fixtureOwner = owner; }, owner);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const ready = async () => { await page.goto(`${origin}/__resources`); await page.locator('body[data-ready="true"]').waitFor({ timeout: 30000 }); };
  await ready();
  let sends = 0;
  await page.route('**/api/clientRuntime/resourceCommand', async route => {
    sends++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('connectionreset');
  });
  const project = await page.evaluate(() => probe.resource({ kind: 'createFolder', name: 'One lost response' }));
  await page.unroute('**/api/clientRuntime/resourceCommand');
  assert.equal(sends, 1);
  assert.equal((await page.evaluate(() => probe.pending())).length, 0, 'lost responses retire automatically without user recovery');
  assert.equal(await page.getByRole('alert').count(), 0);
  const completed = (await page.evaluate(() => probe.all())).find(row => row.id.startsWith('resource-completed:'));
  assert.equal(completed.value.request, undefined, 'success keeps a compact receipt, not the original body');
  assert.equal(completed.value.blob, undefined);

  let transfers = 0;
  await page.route('**/api/v1/projects/*/uploads?operationId=*', async route => {
    transfers++; const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('connectionreset');
  });
  const uploaded = await page.evaluate(id => probe.upload(id), project.id);
  await page.unroute('**/api/v1/projects/*/uploads?operationId=*');
  assert.equal(uploaded.path, 'retained-upload.txt'); assert.equal(transfers, 1);
  assert.equal((await page.evaluate(() => probe.pending())).length, 0);

  const text = await page.evaluate(id => probe.resource({ kind: 'saveProjectText', projectId: id, path: 'progress.md', text: '# Progress', expectedRevision: null }), project.id);
  const course = (await page.evaluate(id => probe.resources(id), project.id)).entries.find(row => row.name === 'progress.md');
  await context.setOffline(true);
  await page.evaluate(async id => { for (let unit = 1; unit <= 40; unit++) await probe.reading(id, unit); }, course.courseId);
  const offline = await page.evaluate(() => probe.pending());
  assert.equal(offline.length, 1, 'forty scroll events coalesce to one durable unsent update');
  assert.equal(offline[0].value.request.operation.unit, 40);
  assert.equal(await page.getByRole('alert').count(), 0, 'offline progress does not become an error/task per scroll');
  let progressSends = 0;
  await page.route('**/api/clientRuntime/resourceCommand', async route => { progressSends++; await route.continue(); });
  await context.setOffline(false); await page.evaluate(() => probe.resume());
  await page.waitForFunction(async () => !(await probe.pending()).length);
  await page.unroute('**/api/clientRuntime/resourceCommand');
  assert.equal(progressSends, 1);
  assert.equal(JSON.parse(store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='videos' AND record_key=?").get(owner, JSON.stringify(course.courseId)).value).lastUnit, 40);

  await page.route('**/api/clientRuntime/resourceCommand', route => route.abort('connectionreset'));
  await page.evaluate(id => probe.reading(id, 41), course.courseId);
  await page.evaluate(() => probe.flush());
  assert.equal((await page.evaluate(() => probe.pending()))[0].value.sent, true);
  await context.setOffline(true);
  await page.evaluate(async id => { for (let unit = 42; unit <= 80; unit++) await probe.reading(id, unit); }, course.courseId);
  const superseded = await page.evaluate(() => probe.pending());
  assert.equal(superseded.length, 1, 'new scoped progress also supersedes failed in-flight attempts without growing a command per event');
  assert.equal(superseded[0].value.request.operation.unit, 80);
  await page.evaluate(async id => { await probe.playback(id, 100, true); await probe.playback(id, 101); }, course.courseId);
  const playback = (await page.evaluate(() => probe.pending())).find(row => row.value.request.operation.kind === 'recordPlayback');
  assert.equal(playback.value.request.operation.finished, true, 'coalescing preserves an explicit completion');
  await page.unroute('**/api/clientRuntime/resourceCommand');
  await context.setOffline(false); await page.evaluate(() => probe.resume());
  assert.equal((await page.evaluate(() => probe.pending())).length, 0);

  let unavailableSends = 0;
  await page.route('**/api/clientRuntime/resourceCommand', route => { unavailableSends++; return route.abort('connectionreset'); });
  await page.evaluate(async id => { try { await probe.resource({ kind: 'saveProjectText', projectId: id, path: 'bounded-retry.md', text: 'recover once', expectedRevision: null }); } catch {} }, project.id);
  for (let attempt = 1; attempt < 6; attempt++) await page.evaluate(() => probe.flush());
  assert.equal(unavailableSends, 6);
  const paused = (await page.evaluate(() => probe.pending()))[0];
  assert.equal(paused.value.state, 'paused');
  await page.evaluate(() => probe.flush());
  assert.equal(unavailableSends, 6, 'a paused command cannot form an unbounded retry loop');
  await page.unroute('**/api/clientRuntime/resourceCommand');
  await page.evaluate(() => probe.resume());
  assert.equal((await page.evaluate(() => probe.pending())).length, 0);
  assert.equal((await page.evaluate(id => probe.text(id, 'bounded-retry.md'), project.id)).text, 'recover once');

  // A stable external replay identity returns its receipt and rejects a changed
  // payload locally; it must not make another physical folder.
  const stable = await page.evaluate(() => probe.resource({ kind: 'createFolder', name: 'Stable caller identity' }, 'guest-stable-original'));
  assert.deepEqual(await page.evaluate(() => probe.resource({ kind: 'createFolder', name: 'Stable caller identity' }, 'guest-stable-original')), stable);
  assert.equal(await page.evaluate(async () => { try { await probe.resource({ kind: 'createFolder', name: 'Wrong changed payload' }, 'guest-stable-original'); return false; } catch { return true; } }), true);

  const other = await context.newPage(); other.on('pageerror', error => errors.push(error.message));
  await other.goto(`${origin}/__resources`); await other.locator('body[data-ready="true"]').waitFor();
  let crossTabSends = 0;
  await context.route('**/api/clientRuntime/resourceCommand', async route => { crossTabSends++; await route.continue(); });
  const concurrent = await Promise.all([page, other].map(tab => tab.evaluate(() => probe.resource({ kind: 'createFolder', name: 'Cross-tab exactly once' }, 'guest-cross-tab-identity'))));
  await context.unroute('**/api/clientRuntime/resourceCommand');
  assert.equal(crossTabSends, 1); assert.deepEqual(concurrent[0], concurrent[1]);
  await other.close();

  let responseReady, releaseResponse;
  const acceptedResponse = new Promise(resolve => { responseReady = resolve; });
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  let lifetimeSends = 0;
  await page.route('**/api/clientRuntime/resourceCommand', async route => {
    lifetimeSends++; const response = await route.fetch(); responseReady(); await responseGate;
    await route.fulfill({ response }).catch(() => {});
  });
  const oldLifetimeSave = page.evaluate(async id => { try { await probe.resource({ kind: 'saveProjectText', projectId: id, path: 'account-lifetime.md', text: 'committed before disposal', expectedRevision: null }); } catch (error) { return error.message; } }, project.id);
  await acceptedResponse; await page.evaluate(() => probe.dispose()); releaseResponse();
  assert.equal(await oldLifetimeSave, 'client_account_changed');
  await page.unroute('**/api/clientRuntime/resourceCommand');
  assert.equal((await page.evaluate(() => probe.pending())).length, 1, 'late callbacks from a disposed same-account lifetime cannot mutate its journal');
  await page.evaluate(() => probe.restart()); await page.evaluate(() => probe.flush());
  assert.equal((await page.evaluate(() => probe.pending())).length, 0, 'a fresh lifetime reconciles the committed receipt');
  assert.equal(lifetimeSends, 1);

  // Known CAS failures preserve the original draft and expose a filename and a
  // comparison, never a command ID/JSON list or an automatic overwrite.
  const original = await page.evaluate(id => probe.text(id, 'progress.md'), project.id);
  await page.evaluate(({ id, revision }) => probe.resource({ kind: 'saveProjectText', projectId: id, path: 'progress.md', text: '# Other device', expectedRevision: revision }), { id: project.id, revision: original.revision });
  const conflict = await page.evaluate(async ({ id, revision }) => {
    try { await probe.resource({ kind: 'saveProjectText', projectId: id, path: 'progress.md', text: '# My retained draft', expectedRevision: revision }); }
    catch (error) { return error.message; }
  }, { id: project.id, revision: original.revision });
  assert.match(conflict, /已保留/);
  await page.getByRole('alert', { name: '资料保存提醒' }).waitFor();
  assert.doesNotMatch(await page.getByRole('alert', { name: '资料保存提醒' }).innerText(), /resource-[0-9a-f]|JSON|原命令/);
  const pendingConflict = (await page.evaluate(() => probe.pending())).find(row => row.value.state === 'conflict');
  assert.equal(pendingConflict.value.request.operation.text, '# My retained draft');
  assert.equal((await page.evaluate(id => probe.text(id, 'progress.md'), project.id)).text, '# Other device');
  await page.getByRole('button', { name: 'Toggle recovery' }).click();
  await page.locator(`button[data-operation-id="${pendingConflict.value.request.operationId}"]`).click();
  await page.getByRole('textbox', { name: '服务器当前内容' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '服务器当前内容' }).inputValue(), '# Other device');
  const draftBox = page.getByRole('textbox', { name: '你的未保存内容（可编辑合并）' });
  assert.equal(await draftBox.inputValue(), '# My retained draft');
  await draftBox.fill('# Merged explicitly');
  await page.getByRole('button', { name: '保存合并后的内容', exact: true }).click();
  await page.locator(`button[data-operation-id="${pendingConflict.value.request.operationId}"]`).waitFor({ state: 'detached' });
  assert.equal((await page.evaluate(id => probe.text(id, 'progress.md'), project.id)).text, '# Merged explicitly');
  assert.ok((await page.evaluate(() => probe.all())).some(row => row.id.startsWith('resource-archived:') && row.value.stored.value.request.operation.text === '# My retained draft'));
  await page.getByRole('button', { name: 'Toggle recovery' }).click();

  // A permanently invalid operation is not retried on reconnect or manual sync.
  let rejectedSends = 0;
  await page.route('**/api/clientRuntime/resourceCommand', async route => { rejectedSends++; await route.continue(); });
  await page.evaluate(async id => { try { await probe.resource({ kind: 'createDirectory', projectId: id, path: '../escape' }); } catch {} }, project.id);
  await page.evaluate(() => probe.resume()); await page.evaluate(() => probe.resume());
  await page.unroute('**/api/clientRuntime/resourceCommand');
  assert.equal(rejectedSends, 1, 'known validation failures never become a retry loop');

  // Existing successful journals are silently retired; an old unknown deletion
  // is preserved without permission to reissue it.
  await page.evaluate(({ completed, id, revision }) => Promise.all([
    probe.seed({ id: `resource-command:${completed.value.operationId}`, value: { state: 'uncertain', request: { operationId: completed.value.operationId, operation: { kind: 'createFolder', name: 'One lost response' } } } }),
    probe.seed({ id: 'resource-command:resource-legacy-unknown-delete', value: { state: 'uncertain', request: { operationId: 'resource-legacy-unknown-delete', operation: { kind: 'remove', projectId: id, path: 'progress.md', revision } } } }),
  ]), { completed, id: project.id, revision: text.revision });
  await page.evaluate(() => probe.flush());
  const legacy = await page.evaluate(() => probe.pending());
  assert.ok(!legacy.some(row => row.value.request.operationId === completed.value.operationId));
  assert.equal(legacy.find(row => row.value.request.operationId === 'resource-legacy-unknown-delete').value.state, 'review');
  assert.equal((await page.evaluate(id => probe.text(id, 'progress.md'), project.id)).text, '# Merged explicitly');

  // A stale browser cannot submit a previously scoped command to a replacement
  // server database, even if the owner string and filename happen to match.
  await page.route('**/api/clientRuntime/resourceCommand', route => route.abort('connectionreset'));
  await page.evaluate(async id => { try { await probe.resource({ kind: 'saveProjectText', projectId: id, path: 'scope-guard.md', text: 'keep local only', expectedRevision: null }); } catch {} }, project.id);
  await page.unroute('**/api/clientRuntime/resourceCommand');
  store.db.prepare('UPDATE resource_command_scopes SET scope=? WHERE owner_id=?').run('replacement-database-scope', owner);
  let staleWrites = 0;
  await page.route('**/api/clientRuntime/resourceCommand', async route => { staleWrites++; await route.continue(); });
  await page.evaluate(() => probe.resume());
  await page.unroute('**/api/clientRuntime/resourceCommand');
  assert.equal(staleWrites, 0);
  const scopeDrafts = await page.evaluate(() => probe.pending());
  assert.ok(scopeDrafts.some(row => row.value.errorCode === 'resource_scope_changed' && row.value.request.operation.text === 'keep local only'), JSON.stringify(scopeDrafts));
  assert.equal(fs.existsSync(path.join(directory, 'files/projects', project.id, 'scope-guard.md')), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(directory, 'business-save-notice.png'), fullPage: true });
  console.log('PASS browser lost receipts/uploads, coalesced offline progress, stable identities, human-readable conflicts/merge, permanent failure isolation, legacy preservation and database-scope fence', directory);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(directory, 'failure.html'), await page.content()); }
  throw error;
} finally { await browser?.close(); await web?.close(); await app.close(); store?.close(); }
