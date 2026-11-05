import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/preference-commands-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import { startCloud, flushCloud } from '/src/cloud/sync.ts';
import { useSettings } from '/src/store/settings.ts';
import { db, useCloudDatabase, WangkeDB, cloudDatabaseName } from '/src/store/db.ts';
import { quarantineExecutorOutbox, listExecutorRecovery, inspectExecutorRecovery, archiveExecutorRecovery } from '/src/cloud/executor-recovery.ts';
import { resourceCommand, readResources, inspectResourceCommand, archiveResourceCommand, uploadResource, migrateResourceOutbox } from '/src/client/resources.ts';
import { disposeServerRuntime, serverRuntime } from '/src/client/bootstrap.ts';
import { cloud } from '/src/cloud/state.ts';
import { markCloudApply } from '/src/cloud/cache.ts';
import { inspectPreferenceCommand, resolvePreferenceCommand, stopPreferences, startPreferences, migratePreferenceOutbox } from '/src/cloud/preferences.ts';
if (location.search === '?legacy=1') {
  cloud.enabled=true; cloud.userId=window.fixtureOwner; useCloudDatabase(window.fixtureOwner); await db.open();
  const before = await db.preferences.get('userName');
  await db.transaction('rw', db.preferences, db.table('_cloudOutbox'), async () => {
    markCloudApply();
    await db.preferences.put({id:'userName',value:'legacy retained draft'});
    await db.table('_cloudOutbox').add({transaction:crypto.randomUUID(),id:crypto.randomUUID(),table:'preferences',key:'userName',before,after:{id:'userName',value:'legacy retained draft'}});
    window.legacyRows = await db.table('_cloudOutbox').toArray();
  });
}
await startCloud(window.fixtureOwner);
window.probe = {
 set(value) { useSettings.setState({userName: value}); },
 setTheme(value) { useSettings.setState({theme: value}); },
 flush: flushCloud,
 pending: async () => (await db.table('_cloudMeta').toArray()).filter(row => row.id.startsWith('preferences-command:')).map(row => row.value),
 rows: () => db.table('_cloudOutbox').toArray(),
 value: () => useSettings.getState().userName,
 inspect: inspectPreferenceCommand, resolve: resolvePreferenceCommand,
 stop: stopPreferences,
 restart: startPreferences,
 async mountPreferences() {
  const React=await import('react'); const {createRoot}=await import('react-dom/client'); const {default:Recovery}=await import('/src/cloud/PreferenceRecovery.tsx');
  const node=document.createElement('main'); document.body.append(node); createRoot(node).render(React.createElement(Recovery));
 },
 archive: () => db.table('_cloudMeta').toArray(),
 async seedMixed() {
  const transaction = crypto.randomUUID();
  cloud.enabled = false;
  try {
  await db.transaction('rw', db.table('_cloudOutbox'), async () => {
   await db.table('_cloudOutbox').bulkAdd([
    {transaction,id:crypto.randomUUID(),table:'preferences',key:'userName',before:{id:'userName',value:'old mixed expected'},after:{id:'userName',value:'mixed retained name'}},
    {transaction,id:crypto.randomUUID(),table:'folders',key:991,before:null,after:{id:991,name:'mixed retained folder',createdAt:42}},
   ]);
  });
  const rows = await db.table('_cloudOutbox').where('transaction').equals(transaction).toArray();
  await migratePreferenceOutbox(); return {transaction,rows};
  } finally { cloud.enabled = true; }
 },
 async seedExecutor() {
  const executor = new WangkeDB(cloudDatabaseName(window.fixtureOwner,true),true); await executor.open();
  const row = {transaction:'executor-original-transaction',id:'executor-original-mutation',table:'files',key:'retained-worker-file',before:null,after:{id:'retained-worker-file',blob:new Blob([new Uint8Array([0,255,127])],{type:'application/octet-stream'})},executorTaskId:'expired-worker-task',permissionId:'original-permit'};
  await executor.table('_cloudOutbox').add(row);
  await quarantineExecutorOutbox(executor); executor.close();
 },
  executorRecovery: () => listExecutorRecovery(window.fixtureOwner),
  async rejectStaleExecutorInspection() {
    const row=(await listExecutorRecovery(cloud.userId))[0], detail=await inspectExecutorRecovery(row.id);
    let imported=false;try{await archiveExecutorRecovery(JSON.parse(JSON.stringify(detail)));}catch(error){imported=error.message==='client_account_changed';}
    disposeServerRuntime();await serverRuntime(cloud.userId);
    let stale=false;try{await archiveExecutorRecovery(detail);}catch(error){stale=error.message==='client_account_changed';}
    return {imported,stale,retained:(await listExecutorRecovery(cloud.userId)).length===1};
  },
   async completeAsExecutor({taskId,token}) {
    cloud.worker=true;cloud.taskId=taskId;cloud.workerToken=token;useCloudDatabase(cloud.userId,true);await db.open();
    try { const {completeExecutor}=await import('/src/cloud/executor-runtime.ts');await completeExecutor({status:'completed',result:{exact:'original outcome'}}); }
    catch(error) { return String(error); }
    finally { cloud.worker=false;cloud.taskId='';cloud.workerToken='';useCloudDatabase(cloud.userId);await db.open(); }
   },
   async fileAsExecutor({taskId,token,permissionId,operation}) {
     cloud.worker=true;cloud.taskId=taskId;cloud.workerToken=token;cloud.permissionId=permissionId;useCloudDatabase(cloud.userId,true);await db.open();
     try {const {executeTaskResource}=await import('/src/cloud/executor-runtime.ts');await executeTaskResource(operation);}
     catch(error){return String(error);}
     finally{cloud.worker=false;cloud.taskId='';cloud.workerToken='';cloud.permissionId='';useCloudDatabase(cloud.userId);await db.open();}
   },
  upload: (projectId)=>uploadResource(projectId,'retained-upload.txt',new Blob([new Uint8Array([0,255,127,42])],{type:'application/octet-stream'})),
  async seedResourceLegacy() {
    const transaction=crypto.randomUUID();cloud.enabled=false;
    try {
      await db.table('_cloudOutbox').bulkAdd([
        {transaction,id:'original-resource-row',table:'folders',key:771,before:null,after:{id:771,name:'legacy resource'}},
        {transaction,id:'original-mixed-file',table:'files',key:'mixed-resource-blob',before:null,after:{id:'mixed-resource-blob',blob:new Blob([new Uint8Array([0,255,127])])}},
      ]);
      await migrateResourceOutbox();return transaction;
    }finally{cloud.enabled=true;}
  },
 resource: resourceCommand,
  resources: readResources,
   async retainHistoricalResource(operation, binary=false) {
     // New commands reconcile themselves. Seed an explicit historical review
     // record to retain coverage of export/archive and stale inspection guards.
     const rows=await db.table('_cloudMeta').where('id').startsWith('resource-completed:').toArray();
     const latest=rows.filter(row=>row.value.kind===operation.kind).sort((a,b)=>b.value.confirmedAt-a.value.confirmedAt)[0];
     if(!latest)throw new Error('missing confirmed resource');
     if(binary){const bytes=new Uint8Array([0,255,127,42]);operation={...operation,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')};}
     await db.table('_cloudMeta').put({id:'resource-command:'+latest.value.operationId,value:{state:'review',request:{operationId:latest.value.operationId,operation},...(binary?{blob:new Blob([new Uint8Array([0,255,127,42])],{type:'application/octet-stream'})}:{})}});
   },
  async rejectStaleResourceInspection() {
    const pending = (await db.table('_cloudMeta').toArray()).find(row=>row.id.startsWith('resource-command:'));
    const detail = await inspectResourceCommand(pending.value.request.operationId);
    disposeServerRuntime(); await serverRuntime(cloud.userId);
    try { await archiveResourceCommand(detail); return {error:null}; }
    catch(error) { return {error:error.message, retained:!!(await db.table('_cloudMeta').get(pending.id))}; }
  },
 async mountResources() {
  const React=await import('react'); const {createRoot}=await import('react-dom/client'); const {default:Recovery}=await import('/src/cloud/ResourceRecovery.tsx');
  const node=document.createElement('main'); document.body.append(node); createRoot(node).render(React.createElement(Recovery));
 },
 async mountExecutor() {
  const React=await import('react'); const {createRoot}=await import('react-dom/client'); const {default:Recovery}=await import('/src/cloud/ExecutorRecovery.tsx');
  const node=document.createElement('main'); document.body.append(node); createRoot(node).render(React.createElement(Recovery));
 },
};
document.body.dataset.ready = 'true';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'preference-commands-fixture', resolveId: id => id === '/__preferences.js' ? '\0preferences-fixture' : undefined,
      load: id => id === '\0preferences-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/__preferences') return next();
        res.setHeader('Content-Type', 'text/html'); res.end('<script type="module" src="/__preferences.js"></script>');
      }); },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'preference-test-password-123' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'preference-test-password-123' } });
  const owner = (await login.json()).user.id;
  await context.addInitScript(owner => { window.fixtureOwner = owner; }, owner);
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(new URL(request.url()).pathname); });
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const ready = async () => { await page.goto(`${origin}/__preferences`); await page.locator('body[data-ready="true"]').waitFor({ timeout: 30000 }); };
  await ready(); await page.evaluate(() => probe.flush());
  let lost = false;
  let markDropped;
  const dropped = new Promise(resolve => { markDropped = resolve; });
  await page.route('**/api/clientRuntime/setPreferences', async route => {
    if (lost) return route.continue();
    lost = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('connectionreset'); markDropped();
  });
  await page.evaluate(() => probe.set('lost response draft'));
  await dropped;
  await page.waitForFunction(async () => (await probe.pending()).some(command => command.state === 'uncertain'));
  const original = (await page.evaluate(() => probe.pending()))[0];
  await page.unroute('**/api/clientRuntime/setPreferences');
  await page.evaluate(() => probe.flush());
  assert.equal((await page.evaluate(() => probe.pending())).length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, original.operationId).n, 1);
  await context.setOffline(true);
  await page.evaluate(() => probe.set('offline retained draft'));
  await page.waitForFunction(async () => (await probe.pending()).length === 1);
  assert.equal(await page.evaluate(() => probe.value()), 'offline retained draft');
  const offline = (await page.evaluate(() => probe.pending()))[0];
  await context.setOffline(false);
  await ready(); await page.evaluate(() => probe.flush());
  assert.equal((await page.evaluate(() => probe.pending())).length, 0);
  assert.equal(await page.evaluate(() => probe.value()), 'offline retained draft');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, offline.operationId).n, 1);
  assert.equal((await page.evaluate(() => probe.rows())).length, 0, 'settings never use generic records outbox');
  assert.equal(requests.includes('/api/clientRuntime/commitRecords'), false, 'settings use no generic commits');
  await page.goto(`${origin}/__preferences?legacy=1`);
  await page.locator('body[data-ready="true"]').waitFor({ timeout: 30000 });
  const legacy = await page.evaluate(() => window.legacyRows);
  assert.equal(legacy.length, 1);
  assert.equal((await page.evaluate(() => probe.rows())).length, 0);
  const archive = (await page.evaluate(() => probe.archive())).find(row => row.id === 'preferences-migration:' + legacy[0].transaction);
  assert.deepEqual(archive.value.rows, legacy, 'legacy mutation IDs, transaction, before and draft retained exactly');
  await page.evaluate(() => probe.flush());
  assert.equal((await page.evaluate(() => probe.pending())).length, 0);
  assert.equal(JSON.parse(store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='preferences' AND record_key=?").get(owner, JSON.stringify('userName')).value).value, 'legacy retained draft');
  assert.equal(requests.includes('/api/clientRuntime/commitRecords'), false, 'all preference writes use the domain command');
  // A second device commits after the first device has captured its expected
  // value, but before that command reaches the Host. Gate actual HTTP dispatch.
  let heldRoute, captured;
  const capturedRequest = new Promise(resolve => { captured = resolve; });
  await page.route('**/api/clientRuntime/setPreferences', route => { heldRoute = route; captured(); });
  await page.evaluate(() => probe.set('conflicting local draft'));
  await capturedRequest;
  const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
  const records = new CloudRecords(store);
  records.apply(owner, [{ id: 'second-device-preference-write', table: 'preferences', key: 'userName', before: records.get(owner, 'preferences', 'userName'), after: { id: 'userName', value: 'second device committed' } }]);
  await heldRoute.continue();
  await page.unroute('**/api/clientRuntime/setPreferences');
  await page.waitForFunction(async () => (await probe.pending()).some(row => row.state === 'conflict'));
  const conflict = (await page.evaluate(() => probe.pending()))[0];
  await page.evaluate(async id => { window.oldInspection = await probe.inspect(id); await probe.restart(); }, conflict.operationId);
  const staleRecovery = await page.evaluate(async id => {
    try { await probe.resolve(id, window.oldInspection, 'retry'); return 'unexpected-success'; } catch (error) { return error.message; }
  }, conflict.operationId);
  assert.equal(staleRecovery, 'client_account_changed', 'old-generation inspections cannot create successor commands');
  await page.evaluate(() => probe.mountPreferences());
  await page.getByRole('button', { name: `核对原命令 ${conflict.operationId}`, exact: true }).click();
  const conflictExport = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出原稿、操作 ID 与收据' }).click();
  await (await conflictExport).saveAs(path.join(directory, 'preference-conflict.json'));
  const inspectedConflict = JSON.parse(fs.readFileSync(path.join(directory, 'preference-conflict.json'), 'utf8'));
  assert.equal(inspectedConflict.command.request.changes[0].value, 'conflicting local draft');
  assert.equal(inspectedConflict.server.values.userName, 'second device committed');
  await page.getByRole('button', { name: '按已核对服务端版本恢复草稿' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '按已核对服务端版本恢复草稿' && !button.disabled));
  fs.writeFileSync(path.join(directory, 'preference-after-recovery.json'), JSON.stringify(await page.evaluate(async () => ({ rows: await probe.archive(), text: document.body.innerText })), null, 2));
  await page.waitForFunction(async () => !(await probe.pending()).length);
  assert.equal(records.get(owner, 'preferences', 'userName').value, 'conflicting local draft');
  const resolved = (await page.evaluate(() => probe.archive())).find(row => row.id === `preferences-resolved:${conflict.operationId}`);
  assert.equal(resolved.value.command.operationId, conflict.operationId);
  assert.equal(resolved.value.command.request.changes[0].expected, conflict.request.changes[0].expected, 'archive preserves original CAS expected value');
  assert.ok(resolved.value.successor);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, resolved.value.successor).n, 1);
  const secondPage = await context.newPage();
  await secondPage.goto(`${origin}/__preferences`);
  await secondPage.locator('body[data-ready="true"]').waitFor({ timeout: 30000 });
  await Promise.all([page.evaluate(() => probe.set('multi-tab committed name')), secondPage.evaluate(() => probe.setTheme('dark'))]);
  await Promise.all([page.evaluate(() => probe.flush()), secondPage.evaluate(() => probe.flush())]);
  assert.equal(records.get(owner, 'preferences', 'userName').value, 'multi-tab committed name');
  assert.equal(records.get(owner, 'preferences', 'theme').value, 'dark');
  await secondPage.close();
  // Stop the automatic cache drain while installing an exact legacy fixture;
  // conversion must archive the entire atomic transaction, never split it.
  const mixed = await page.evaluate(() => probe.seedMixed());
  const mixedArchive = (await page.evaluate(() => probe.archive())).find(row => row.id === `preferences-migration:${mixed.transaction}`);
  assert.deepEqual(mixedArchive.value.rows, mixed.rows);
  assert.equal(mixedArchive.value.state, 'review');
  assert.equal((await page.evaluate(() => probe.rows())).length, 0);
  const mixedId = `pref-migrate-${mixed.transaction}`;
  assert.equal((await page.evaluate(() => probe.pending())).find(row => row.operationId === mixedId).state, 'conflict');
  const mixedInspection = await page.evaluate(id => probe.inspect(id), mixedId);
  assert.equal(mixedInspection.receipt.status, 'missing');
  await page.evaluate(async id => {
    await probe.resolve(id, await probe.inspect(id), 'discard');
  }, mixedId);
  assert.equal(records.get(owner, 'folders', 991), null, 'mixed resource mutation was archived, not silently sent separately');
  assert.equal(records.get(owner, 'preferences', 'userName').value, 'multi-tab committed name');
  await page.evaluate(() => probe.seedExecutor());
  assert.deepEqual(await page.evaluate(() => probe.rejectStaleExecutorInspection()), { imported: true, stale: true, retained: true });
  await page.evaluate(() => probe.mountExecutor());
  await page.getByRole('button', { name: /核对原任务与收据/ }).click();
  await page.getByText('原任务不会自动重跑，也不会借用新任务的 lease/permit。归档保留完整原稿与二进制附件。').waitFor();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出完整原稿和附件字节' }).click();
  const exported = await download; const exportPath = path.join(directory, 'executor-recovery-export.json'); await exported.saveAs(exportPath);
  const exportedValue = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.deepEqual(exportedValue.row.rows[0].after.blob.bytes, [0,255,127]);
  assert.equal(exportedValue.row.rows[0].id, 'executor-original-mutation');
  assert.equal(exportedValue.row.rows[0].permissionId, 'original-permit');
  assert.equal(exportedValue.server.operations[0].committed, false);
  await page.getByRole('button', { name: '确认核对并归档（不重放）' }).click();
  await page.waitForFunction(async () => (await probe.executorRecovery()).length === 0);
  assert.equal(requests.includes('/api/clientRuntime/submitTask'), false, 'recovery UI never replays an uncertain task');
  let resourceSends = 0;
  await page.route('**/api/clientRuntime/resourceCommand', async route => {
    resourceSends++;
    const response = await route.fetch(); assert.equal(response.status(), 200);
    await route.abort('connectionreset');
  });
  await page.evaluate(async () => {
    try { await probe.resource({kind:'createFolder',name:'Lost resource response'}); } catch {}
  });
  await page.unroute('**/api/clientRuntime/resourceCommand');
  assert.equal((await page.evaluate(()=>probe.archive())).filter(row=>row.id.startsWith('resource-command:')).length,0,'lost response confirms automatically');
  await page.evaluate(()=>probe.retainHistoricalResource({kind:'createFolder',name:'Lost resource response'}));
  await page.reload(); await page.locator('body[data-ready="true"]').waitFor({ timeout: 30000 });
  assert.equal(resourceSends, 1, 'reload never replays a possibly committed filesystem operation');
  await page.evaluate(() => probe.mountResources());
  await page.locator('button[data-operation-id]').click();
  await page.getByText('未确认的原稿已保留。归档不会重新执行操作，也不会覆盖服务器文件。').waitFor();
  const resourceDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出资源完整原稿' }).click();
  const resourceExport = await resourceDownload; await resourceExport.saveAs(path.join(directory,'resource-recovery-export.json'));
  const resourceEvidence = JSON.parse(fs.readFileSync(path.join(directory,'resource-recovery-export.json'),'utf8'));
  assert.equal(resourceEvidence.receipt.status,'completed');
  assert.equal(resourceEvidence.stored.value.request.operation.name,'Lost resource response');
  assert.equal(resourceEvidence.directories[0].entries.filter(entry=>entry.name==='Lost resource response').length,1);
  await page.getByRole('button', { name: '确认核对并归档资源原稿（不重放）' }).click();
  await page.waitForFunction(async () => !(await probe.archive()).some(row=>row.id.startsWith('resource-command:')));
  const textProject = await page.evaluate(() => probe.resource({kind:'createFolder',name:'Project text recovery'}));
  let textSends = 0;
  await page.route('**/api/clientRuntime/resourceCommand', async route => {
    textSends++;
    const response = await route.fetch(); assert.equal(response.status(), 200);
    await route.abort('connectionreset');
  });
  await page.evaluate(async projectId => {
    try { await probe.resource({kind:'saveProjectText',projectId,path:'original.md',text:'# Retained project text\n',expectedRevision:null}); } catch {}
  }, textProject.id);
  await page.unroute('**/api/clientRuntime/resourceCommand');
  await page.evaluate(projectId=>probe.retainHistoricalResource({kind:'saveProjectText',projectId,path:'original.md',text:'# Retained project text\n',expectedRevision:null}),textProject.id);
  // The original target is now trashed. Directory inspection may fail, but must
  // not make the durable draft and committed receipt impossible to export.
  await page.evaluate(projectId => probe.resource({kind:'trash',projectId}), textProject.id);
  await page.reload(); await page.locator('body[data-ready="true"]').waitFor({timeout:30000});
  assert.equal(textSends, 1);
  assert.deepEqual(await page.evaluate(() => probe.rejectStaleResourceInspection()), {error:'client_account_changed',retained:true}, 'same-account new runtime generation must reject stale archive authority');
  await page.evaluate(() => probe.mountResources());
  await page.locator('button[data-operation-id]').click();
  await page.getByText('未确认的原稿已保留。归档不会重新执行操作，也不会覆盖服务器文件。').waitFor();
  const textDownload = page.waitForEvent('download');
  await page.getByRole('button', {name:'导出资源完整原稿'}).click();
  await (await textDownload).saveAs(path.join(directory,'project-text-recovery.json'));
  const textEvidence = JSON.parse(fs.readFileSync(path.join(directory,'project-text-recovery.json'),'utf8'));
  assert.equal(textEvidence.stored.value.request.operation.text, '# Retained project text\n');
  assert.equal(textEvidence.stored.value.request.operation.expectedRevision, null);
  assert.equal(textEvidence.receipt.status, 'completed');
  assert.ok(textEvidence.trash.projects.some(project=>project.id===textProject.id));
  await page.getByRole('button', {name:'确认核对并归档资源原稿（不重放）'}).click();
  await page.waitForFunction(async () => !(await probe.archive()).some(row=>row.id.startsWith('resource-command:')));
  assert.deepEqual(errors, []);
  // Lost binary responses auto-confirm. Historical review exports still retain
  // all original bytes without issuing another transfer.
  const uploadProject = await page.evaluate(() => probe.resource({kind:'createFolder',name:'Binary recovery'}));
  let binarySends=0;
  await page.route('**/api/v1/projects/*/uploads?operationId=*', async route => {
    binarySends++;const response=await route.fetch();assert.equal(response.status(),201);await route.abort('connectionreset');
  });
  await page.evaluate(async projectId=>{try{await probe.upload(projectId);}catch{}},uploadProject.id);
  await page.unroute('**/api/v1/projects/*/uploads?operationId=*');
  await page.evaluate(projectId=>probe.retainHistoricalResource({kind:'upload',projectId,path:'retained-upload.txt',size:4,sha256:'historical',contentType:'application/octet-stream'},true),uploadProject.id);
  await page.reload();await page.locator('body[data-ready="true"]').waitFor({timeout:30000});
  assert.equal(binarySends,1);
  await page.evaluate(()=>probe.mountResources());
  await page.locator('button[data-operation-id]').click();
  const binaryDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出资源完整原稿'}).click();
  await (await binaryDownload).saveAs(path.join(directory,'binary-resource-recovery.json'));
  const binaryEvidence=JSON.parse(fs.readFileSync(path.join(directory,'binary-resource-recovery.json'),'utf8'));
  assert.equal(binaryEvidence.receipt.status,'completed');
  assert.deepEqual([...Buffer.from(binaryEvidence.stored.value.blob.$blob,'base64')],[0,255,127,42]);
  await page.getByRole('button',{name:'确认核对并归档资源原稿（不重放）'}).click();
  await page.waitForFunction(async()=>!(await probe.archive()).some(row=>row.id.startsWith('resource-command:')));
  const resourceTransaction=await page.evaluate(()=>probe.seedResourceLegacy());
  assert.equal((await page.evaluate(()=>probe.rows())).length,0);
  await page.reload();await page.locator('body[data-ready="true"]').waitFor({timeout:30000});await page.evaluate(()=>probe.mountResources());
  await page.locator('button[data-operation-id]').click();
  const legacyResourceDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出资源完整原稿'}).click();
  await (await legacyResourceDownload).saveAs(path.join(directory,'legacy-resource-recovery.json'));
  const legacyResource=JSON.parse(fs.readFileSync(path.join(directory,'legacy-resource-recovery.json'),'utf8'));
  assert.equal(legacyResource.stored.value.legacy.transaction,resourceTransaction);
  assert.equal(legacyResource.stored.value.legacy.rows.length,2);
  assert.deepEqual([...Buffer.from(legacyResource.stored.value.legacy.rows[1].after.blob.$blob,'base64')],[0,255,127]);
  assert.equal(legacyResource.receipt.status,'missing');
  assert.equal(records.get(owner,'folders',771),null,'legacy resource transaction was not executed');
  await page.getByRole('button',{name:'确认核对并归档资源原稿（不重放）'}).click();
  await page.waitForFunction(async()=>!(await probe.archive()).some(row=>row.id.startsWith('resource-command:')));
  // A real terminal completion survives page reload and credential expiry.
  const {workerTokens,workerTokenHash}=await import('../apps/api/src/cloud/workerAuth.ts');
  const taskId='completion-reload-task',token='completion-reload-token',at=new Date().toISOString();
  workerTokens.set(token,{id:owner,taskId,expiresAt:Date.now()+30000});
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,worker_id,lease_expires_at,created_at,updated_at) VALUES(?,?,?,'cover','recovery','{}','running','browser',?,?,?,?)")
    .run(taskId,owner,taskId,workerTokenHash(token),new Date(Date.now()+30000).toISOString(),at,at);
  let completionSends=0;
  await page.route('**/api/executorRuntime/complete',async route=>{completionSends++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('connectionreset');});
  await page.evaluate(value=>probe.completeAsExecutor(value),{taskId,token});
  workerTokens.get(token).expiresAt=Date.now()-1;
  await page.unroute('**/api/executorRuntime/complete');
  await page.reload();await page.locator('body[data-ready="true"]').waitFor({timeout:30000});
  await page.evaluate(()=>probe.mountExecutor());
  await page.getByRole('button',{name:/核对原任务与收据/}).click();
  const completionDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出完整原稿和附件字节'}).click();
  await (await completionDownload).saveAs(path.join(directory,'completion-reload-recovery.json'));
  const completion=JSON.parse(fs.readFileSync(path.join(directory,'completion-reload-recovery.json'),'utf8'));
  assert.equal(completion.receipt.status,'completed');
  assert.equal(completion.server.task.status,'completed');
  assert.deepEqual(completion.row.value.request.outcome,{status:'completed',result:{exact:'original outcome'}});
  assert.equal(completionSends,1,'expired credential account recovery never replays completion or task');
  await page.getByRole('button',{name:'确认核对并归档（不重放）'}).click();
  await page.waitForFunction(async()=>(await probe.executorRecovery()).length===0);
  const fileTaskId='file-recovery-task',fileToken='file-recovery-token',filePermit='file-recovery-permit';
  const fileOperation={kind:'saveMarkdown',courseId:'recovery-file.md',name:'recovery-file.md',text:'# Retained worker draft\n',expected:'',createOnly:true};
  workerTokens.set(fileToken,{id:owner,taskId:fileTaskId,expiresAt:Date.now()+30000});
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,worker_id,lease_expires_at,created_at,updated_at) VALUES(?,?,?,'qa','recovery','{}','running','browser',?,?,?,?)")
    .run(fileTaskId,owner,fileTaskId,workerTokenHash(fileToken),new Date(Date.now()+30000).toISOString(),at,at);
  store.db.prepare('INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,status,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(filePermit,owner,fileTaskId,'write',JSON.stringify({tool:'edit',arguments:{path:'/recovery-file.md',create:true,content:fileOperation.text}}),'consumed',at);
  let fileSends=0;
  await page.route('**/api/executorRuntime/resourceCommand',async route=>{fileSends++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('connectionreset');});
  await page.evaluate(value=>probe.fileAsExecutor(value),{taskId:fileTaskId,token:fileToken,permissionId:filePermit,operation:fileOperation});
  workerTokens.get(fileToken).expiresAt=Date.now()-1;
  await page.unroute('**/api/executorRuntime/resourceCommand');
  await page.reload();await page.locator('body[data-ready="true"]').waitFor({timeout:30000});
  assert.equal((await page.evaluate(()=>probe.executorRecovery())).length,1);
  assert.deepEqual(await page.evaluate(()=>probe.rejectStaleExecutorInspection()),{imported:true,stale:true,retained:true});
  await page.evaluate(()=>probe.mountExecutor());
  await page.getByRole('button',{name:/核对原任务与收据/}).click();
  const fileDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出完整原稿和附件字节'}).click();
  await (await fileDownload).saveAs(path.join(directory,'worker-file-recovery.json'));
  const fileRecovery=JSON.parse(fs.readFileSync(path.join(directory,'worker-file-recovery.json'),'utf8'));
  assert.equal(fileRecovery.receipt.status,'completed');
  assert.deepEqual(fileRecovery.row.value.request.operation,fileOperation);
  assert.equal(fileRecovery.observed.document.text,fileOperation.text);
  assert.equal(fileSends,1,'account recovery after reload never replays worker filesystem effects');
  await page.getByRole('button',{name:'确认核对并归档（不重放）'}).click();
  await page.waitForFunction(async()=>(await probe.executorRecovery()).length===0);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ pass: true, original, offline, legacy, archive, requests, errors }, null, 2));
  console.log(`PASS: preference domain command/lost response/offline/reload/exact legacy conversion; executor Blob recovery and resource lost-response/reload/inspect/export/archive without replay (${directory})`);
} finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
