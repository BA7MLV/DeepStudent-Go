/** Production adapters + real SQLite/Remote/WS/IDB. Only transport faults are injected. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { verifyExecutorRecovery } from './fixtures/executor-recovery.mjs';
import { waitForProbe } from './fixtures/wait-for-probe.mjs';
import { verifyTruthProducerUI } from './fixtures/truth-producer-ui.mjs';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/single-source-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
const contexts = [];
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React from 'react';
import i18n from '/src/i18n/index.ts';
import {createRoot} from 'react-dom/client';
import Dexie from 'dexie';
import {startCloud,flushCloud} from '/src/cloud/sync.ts';
import {db,legacyCloudDatabaseName,useCloudDatabase} from '/src/store/db.ts';
import {cloud} from '/src/cloud/state.ts';
import {serverRuntime} from '/src/client/bootstrap.ts';
import {queueLearning,drainLearning,learningEdit,saveSkillPackage,addStudyTime,clearStudyTime,saveAnnotations,reviewCard,saveHandoutReading} from '/src/client/learning.ts';
import {forkServerSession,deleteServerSession} from '/src/client/conversations.ts';
import LearningRecovery from '/src/cloud/LearningRecovery.tsx';
import {MaterialInkProvider,useMaterialInk} from '/src/components/MaterialInk.tsx';
import {FeedbackHost} from '/src/ui/feedback.tsx';
import '/src/theme.css';
import '/src/transitions.css';
if(window.fixtureLegacy&&!await Dexie.exists(legacyCloudDatabaseName(window.fixtureOwner))){const old=new Dexie(legacyCloudDatabaseName(window.fixtureOwner));old.version(1).stores({_cloudOutbox:'++sequence,transaction',_cloudMeta:'&id'});await old.open();const row=(id,date,extra={})=>({id:'legacy-mutation-'+id,transaction:'legacy-transaction-'+id,table:'studyDays',key:date,before:null,after:{date,seconds:4,updatedAt:1},...extra});await old.table('_cloudOutbox').bulkAdd([
{...row('original','2026-11-06'),id:'legacy-study-mutation-original',transaction:'legacy-study-transaction-original'},
row('permitted','2026-11-07',{permissionId:'legacy-permit'}),row('executor','2026-11-08',{executorTaskId:'legacy-task'}),
row('negative-baseline','2026-11-09',{before:{date:'2026-11-09',seconds:-2,updatedAt:0}}),
row('mixed','2026-11-10'),{id:'legacy-file-mutation',transaction:'legacy-transaction-mixed',table:'files',key:'legacy-file',before:null,after:{id:'legacy-file'}},
row('coerced','2026-11-11',{after:{date:'2026-11-11',seconds:'4',updatedAt:1}})
]);await old.table('_cloudMeta').put({id:'resource-command:legacy-dormant',value:{state:'queued',request:{operationId:'legacy-dormant-operation',operation:{kind:'legacyReview'}},blob:new Blob(['legacy-command-bytes'])}});old.close();}
await startCloud(window.fixtureOwner);
const root=createRoot(document.getElementById('root'));
function InkProbe(){const ink=useMaterialInk();window.ink=ink;return React.createElement('p',{'data-testid':'ink-state'},JSON.stringify({ready:ink.ready,count:[...ink.strokes.values()].flat().length,status:ink.status,error:ink.error}));}
window.probe={
  flush:flushCloud,drain:drainLearning,
  get: (table,key)=>db.table(table).get(key),
  commands:()=>db.table('_learningCommands').toArray(),
  studySnapshot:()=>db.studyDays.toArray(),
  clearStudy:(expected,id)=>clearStudyTime(expected,id),
  async seed(){const runtime=await serverRuntime(window.fixtureOwner);await runtime.editLearning({operationId:'fixture-create-session-000001',edits:[learningEdit({kind:'conversationSession',expected:null,value:{id:41,videoId:'library-assistant',title:'Original',createdAt:1}})]});await flushCloud();},
  async queueTitle(title,expected){const row=expected??await db.chatSessions.get(41);return queueLearning([learningEdit({kind:'conversationSession',expected:row,value:{...row,title}})],['session:41']);},
  async study(seconds=5){return queueLearning([learningEdit({kind:'studyTime',date:'2026-11-04',seconds,updatedAt:1})],['study:2026-11-04']);},
  async direct(){try{await db.chatSessions.update(41,{title:'forged'});return false;}catch(e){return e.message;}},
  async rebuild(){await db.table('_cloudMeta').put({id:'records-epoch',value:'old-generation'});await db.table('_cloudMeta').put({id:'cursor',value:Number.MAX_SAFE_INTEGER});await flushCloud();},
  async draftBlob(){await db.table('_cloudMeta').put({id:'draft-preserve',value:{blob:new Blob(['draft-bytes'])}});},
  async draftText(){return (await db.table('_cloudMeta').get('draft-preserve')).value.blob.text();},
   skill:()=>saveSkillPackage(null,{id:71,name:'Fixture package',description:'Atomic package',body:'fixture skill',enabled:1,builtin:0,updatedAt:1},[{path:'references/notes.md',body:'support text'}]),
   stableStudy:(id,seconds)=>addStudyTime([['2026-11-05',seconds]],id),
    async productEdits(){await reviewCard(81,1,0);await saveHandoutReading(91,{anchor:'section-one',offset:12});const stroke={id:'annotation-one',materialId:'fixture-course',surface:'page:1',tool:'pen',color:'#000000',width:2,height:1000,points:[],createdAt:1};await saveAnnotations('fixture-course',[],[stroke],'annotation-create-stable');await saveAnnotations('fixture-course',[],[stroke],'annotation-create-stable');await saveAnnotations('fixture-course',[stroke],[],'annotation-undo-stable');},
   async queueBlob(){const expected=await db.handouts.get(91);return queueLearning([learningEdit({kind:'handoutDocument',expected,value:{...expected,blob:new Blob(['pending-handout-bytes'],{type:'text/markdown'})}})],['handout:91']);},
   async pendingBlob(id){const row=(await this.commands()).find(row=>row.operationId===id);return row.request.edits[0].value.blob.text();},
   async fork(){const session=await db.chatSessions.get(41);return forkServerSession(session,[]);},
   deleteSession:id=>deleteServerSession(id,[]),
    async showHistory(pendingOnly){const {default:ExecutorRecovery}=await import('/src/cloud/ExecutorRecovery.tsx');root.render(React.createElement(ExecutorRecovery,{pendingOnly}));},
    async openHistory(){const {default:HistoryRecovery}=await import('/src/cloud/HistoryRecovery.tsx');root.render(React.createElement(HistoryRecovery));},
    historyCount:()=>db.table('_historyTransactions').count(),
   locale: value=>i18n.changeLanguage(value),
   showInk(){root.render(React.createElement(MaterialInkProvider,{materialId:'fixture-course'},React.createElement(InkProbe)));},
    showLearning(){root.render(React.createElement(React.Fragment,null,React.createElement(LearningRecovery),React.createElement(FeedbackHost)));},
    async showProducer(kind){const module=await (kind==='chat'?import('/src/components/ChatPanel.tsx'):kind==='skills'?import('/src/components/SkillsCard.tsx'):import('/src/components/CardsPanel.tsx'));root.render(React.createElement(React.Fragment,null,React.createElement(module.default,kind==='skills'?{}:{videoId:'fixture-course',videoName:'Fixture course',playerRef:{current:null},hasSubtitles:true,materialKind:'para',materialFormat:'md'}),React.createElement(FeedbackHost)));},
   async hashAccountFence(){const expected=await db.handouts.get(91),blob=new Blob(['delayed old-account input']);let release,entered;const started=new Promise(resolve=>entered=resolve);blob.arrayBuffer=()=>{entered();return new Promise(resolve=>release=()=>resolve(new TextEncoder().encode('delayed old-account input').buffer));};const result=queueLearning([learningEdit({kind:'handoutDocument',expected,value:{...expected,blob}})],['handout:91'],'late-old-generation-input').then(()=> 'WRONGLY_ACCEPTED',error=>error.message);await started;cloud.userId='temporary-other-account';useCloudDatabase(cloud.userId);cloud.userId=window.fixtureOwner;useCloudDatabase(cloud.userId);release();const error=await result;await startCloud(window.fixtureOwner);return {error,leaked:await db.table('_learningCommands').where('operationId').equals('late-old-generation-input').count()};},
};
document.body.dataset.ready='true';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'single-source-production-fixture',
      resolveId: id => id === '/__truth-entry.js' ? '\0truth-fixture' : undefined,
      load: id => id === '\0truth-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== '/__truth') return next();
        res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__truth-entry.js"></script>');
      }); },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
  const viewport = process.env.NARROW ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  // WebKit 2359 private sessions cannot store IDB Blob/File (upstream #42795).
  // Use fresh test-only persistent profiles, never a user's browser profile.
  // No application/Blob assertion changes: each device still has isolated IDB.
  const createContext = async name => {
    const context = engine === webkit
      ? await engine.launchPersistentContext(path.join(directory, name), { headless: true, viewport })
      : await browser.newContext({ viewport });
    contexts.push(context); return context;
  };
  if (engine !== webkit) browser = await engine.launch({ headless: true });
  const context = await createContext('device-a-profile');
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'single-truth-password-123' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'single-truth-password-123' } });
  const owner = (await login.json()).user.id;
  await context.addInitScript(owner => { window.fixtureOwner = owner; window.fixtureLegacy=true; }, owner);
  const device = await createContext('device-b-profile');
  await device.addCookies(await context.cookies());
  await device.addInitScript(owner => { window.fixtureOwner = owner; }, owner);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const page = await context.newPage(), second = await device.newPage();
  const errors = [];
  for (const tab of [page, second]) tab.on('pageerror', error => {
    errors.push({ message: error.message, stack: error.stack });
    fs.writeFileSync(path.join(directory, 'page-errors.json'), JSON.stringify(errors, null, 2));
  });
  await page.goto(`${origin}/__truth`); await page.locator('body[data-ready="true"]').waitFor();
  assert.equal(records.get(owner,'studyDays','2026-11-06'),null,'startup must not replay historical transactions');
  assert.equal(await page.evaluate(()=>probe.historyCount()),0,'startup must not load and copy historical data');
  assert.equal(await page.evaluate(()=>probe.get('_cloudMeta','resource-command:legacy-dormant')),undefined,'old journals must not become active commands');
  await page.evaluate(()=>probe.openHistory());
  const reconcileHistory=page.getByRole('button',{name:'核对历史收据并恢复可验证时长命令',exact:true});
  await reconcileHistory.waitFor();
  await waitForProbe(page,async()=>await probe.historyCount()>0);
  assert.equal(records.get(owner,'studyDays','2026-11-06'),null,'opening history only preserves local evidence');
  assert.equal(await page.evaluate(()=>probe.get('_cloudMeta','resource-command:legacy-dormant')),undefined,'preservation must not revive historical journals');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner,'legacy-study-transaction-original').n,0);
  await reconcileHistory.click();
  await page.getByRole('status').filter({hasText:'已按原身份保存可验证的学习时长命令'}).waitFor();
  await page.evaluate(()=>probe.flush());
  await waitForProbe(page,async()=>(await probe.get('studyDays','2026-11-06'))?.seconds===4);
  assert.equal(records.get(owner,'studyDays','2026-11-06').seconds,4);
  for (const date of ['2026-11-07','2026-11-08','2026-11-09','2026-11-10','2026-11-11']) assert.equal(records.get(owner,'studyDays',date),null,'unsafe old intent must remain whole and review-only');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner,'legacy-study-transaction-original').n,1);
  await page.evaluate(() => probe.seed());
  await second.goto(`${origin}/__truth`); await second.locator('body[data-ready="true"]').waitFor();
  await waitForProbe(second, async () => (await probe.get('chatSessions',41))?.title === 'Original');
  assert.match(await page.evaluate(() => probe.direct()), /cloud_projection_read_only/);

  // Device B commits while A retains a stale draft. Conflict must not gate feed.
  const stale = await page.evaluate(() => probe.get('chatSessions',41));
  await second.evaluate(async () => { await probe.queueTitle('Device B'); await probe.drain(); await probe.flush(); });
  await waitForProbe(page, async () => (await probe.get('chatSessions',41))?.title === 'Device B');
  const conflict = await page.evaluate(async expected => { const id=await probe.queueTitle('Stale device A',expected);await probe.drain();return id; }, stale);
  await waitForProbe(page, async id => (await probe.commands()).find(row=>row.operationId===id)?.state==='conflict', conflict);
  await page.evaluate(async () => { await probe.study(); await probe.drain(); await probe.flush(); });
  await waitForProbe(page, async () => (await probe.get('studyDays','2026-11-04'))?.seconds === 5);
  assert.equal(records.get(owner,'chatSessions',41).title,'Device B');
  assert.equal((await page.evaluate(() => probe.commands())).find(row=>row.operationId===conflict).request.edits[0].value.title,'Stale device A');

  // A dependent command stays queued; unrelated command continues.
  const dependent = await page.evaluate(async () => { const id=await probe.queueTitle('Dependent');await probe.study(2);await probe.drain();await probe.flush();return id; });
  assert.equal((await page.evaluate(() => probe.commands())).find(row=>row.operationId===dependent).state,'queued');
  assert.equal(records.get(owner,'studyDays','2026-11-04').seconds,7);

  // Submit succeeds on SQLite, response is lost. The same ID must reconcile on
  // reload and another tab, without adding another delta or dropping the draft.
  let lostId;
  await context.route('**/api/clientRuntime/editLearning', async route => {
    const data=route.request().postDataJSON(); lostId=data.payload.args.request.operationId;
    await route.fetch(); await route.abort('failed');
  });
  const lost = await page.evaluate(async () => {const id=await probe.study(11);await probe.drain();return id;});
  assert.equal(lostId,lost);
  await context.unroute('**/api/clientRuntime/editLearning');
  const tab = await context.newPage();
  await Promise.all([page.reload(),tab.goto(`${origin}/__truth`)]);
  for (const target of [page,tab]) await target.locator('body[data-ready="true"]').waitFor();
  assert.equal(records.get(owner,'studyDays','2026-11-06').seconds,4);
  await waitForProbe(page, async id => !(await probe.commands()).some(row=>row.operationId===id),lost);
  assert.equal(records.get(owner,'studyDays','2026-11-04').seconds,18);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner,lost).n,1);

  // Cache rebuild replaces only confirmed projection, preserving conflict,
  // dependent command, private draft Blob, and latest tombstones.
  const forked=await second.evaluate(()=>probe.fork());
  assert.equal(records.get(owner,'chatSessions',forked).title,'Device B · 分支');
  await second.evaluate(id=>probe.deleteSession(id),forked);
  assert.equal(records.get(owner,'chatSessions',forked),null);
  assert.equal(records.get(owner,'chatSessions',41).title,'Device B');
  await page.evaluate(() => probe.draftBlob());
  const before=records.get(owner,'chatSessions',41);
  records.apply(owner,[{id:crypto.randomUUID(),table:'chatSessions',key:41,before,after:null}]);
  await page.evaluate(() => probe.rebuild());
  assert.equal(await page.evaluate(() => probe.get('chatSessions',41)),undefined);
  assert.equal(await page.evaluate(() => probe.draftText()),'draft-bytes');
  assert.ok((await page.evaluate(() => probe.commands())).some(row=>row.operationId===conflict));
  await second.evaluate(async expected => {await probe.queueTitle('Must not resurrect',expected);await probe.drain();await probe.flush();},before);
  assert.equal(records.get(owner,'chatSessions',41),null);

  await second.evaluate(() => probe.skill());
  assert.equal(records.get(owner,'skills',71).body,'fixture skill');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM cloud_records WHERE owner_id=? AND table_name='skillRefs' AND value IS NOT NULL AND json_extract(value,'$.skillId')=71").get(owner).n,1);

  // Real producer adapters: reviews/reading/annotation undo, and stable guest
  // increments reject an ID reused with changed input even after retirement.
  const upload=await context.request.post(`${origin}/api/v1/files`,{headers:{'content-type':'application/octet-stream','x-file-name':'fixture.md','x-file-mime':'text/markdown'},data:Buffer.from('confirmed handout')});
  assert.equal(upload.status(),201);
  const file=await upload.json();
  for(const [table,key,value] of [
    ['videos','fixture-course',{id:'fixture-course',name:'Fixture course'}],
    ['cards',81,{id:81,videoId:'fixture-course',time:0,status:0}],
    ['handouts',91,{id:91,videoId:'fixture-course',createdAt:1,title:'Fixture handout',outlineJson:'[]',blob:{$file:file.id,type:'text/markdown'}}],
  ]) records.apply(owner,[{id:crypto.randomUUID(),table,key,before:null,after:value}]);
  await second.evaluate(()=>probe.flush());
  await second.evaluate(()=>probe.productEdits());
  assert.equal(records.get(owner,'cards',81).status,1);
  assert.deepEqual(records.get(owner,'handouts',91).readPos,{anchor:'section-one',offset:12});
  assert.equal(records.get(owner,'materialInk','annotation-one'),null);
  await second.evaluate(async()=>{await probe.stableStudy('guest-delta-stable',3);await probe.flush();await probe.stableStudy('guest-delta-stable',3);await probe.flush();});
  assert.equal(records.get(owner,'studyDays','2026-11-05').seconds,3);
  await assert.rejects(second.evaluate(()=>probe.stableStudy('guest-delta-stable',4)),/learning_operation_id_reused/);

  await context.route('**/api/clientRuntime/editLearning',route=>route.abort('failed'));
  const blobId=await page.evaluate(async()=>{await probe.flush();const id=await probe.queueBlob();await probe.drain();return id;});
  await page.evaluate(()=>probe.rebuild());
  assert.equal(await page.evaluate(id=>probe.pendingBlob(id),blobId),'pending-handout-bytes');
  assert.equal(await page.evaluate(async()=> (await probe.get('handouts',91)).blob.text()),'confirmed handout');
  await context.unroute('**/api/clientRuntime/editLearning');
  await page.evaluate(()=>probe.flush());
  try { await waitForProbe(page,async id=>!(await probe.commands()).some(row=>row.operationId===id),blobId); }
  catch(error){console.error(await page.evaluate(()=>probe.commands()));throw error;}
  assert.equal(await page.evaluate(async()=> (await probe.get('handouts',91)).blob.text()),'pending-handout-bytes');

  // Real React provider: several offline strokes become separate durable
  // intents immediately, survive reload, and converge when the carrier returns.
  await context.route('**/api/clientRuntime/editLearning',route=>route.abort('failed'));
  await page.evaluate(()=>probe.showInk());
  await waitForProbe(page,()=>window.ink?.ready===true);
  await page.evaluate(()=>{for(const id of ['offline-ink-one','offline-ink-two'])ink.commit({remove:[],add:[{id,materialId:'fixture-course',surface:'page:1',tool:'pen',color:'#000',width:2,height:1000,points:[],createdAt:2}]});});
  await waitForProbe(page,async()=> (await probe.commands()).filter(row=>row.entities.includes('ink:fixture-course')).length===2);
  assert.equal(await page.evaluate(()=>probe.get('materialInk','offline-ink-one')),undefined);
  await page.reload();await page.locator('body[data-ready="true"]').waitFor();
  await page.evaluate(()=>probe.showInk());
  await waitForProbe(page,()=>window.ink?.ready&&[...ink.strokes.values()].flat().length===2);
  assert.match(await page.getByTestId('ink-state').textContent(),/等待服务器确认/);
  await context.unroute('**/api/clientRuntime/editLearning');await page.evaluate(()=>probe.flush());
  await waitForProbe(page,async()=> !(await probe.commands()).some(row=>row.entities.includes('ink:fixture-course')));
  await waitForProbe(page,()=>ink.status.includes('已确认'));
  assert.equal(records.get(owner,'materialInk','offline-ink-two').id,'offline-ink-two');

  // Explicit conflict resolution archives the original draft atomically, then
  // allows its dependent command to be checked (not silently discarded).
  await page.evaluate(()=>probe.showLearning());
  const conflictDetail=page.locator('details').filter({has:page.getByText(conflict,{exact:true})}).first();
  await conflictDetail.locator('summary').first().click();
  await conflictDetail.getByRole('button',{name:'保留原稿并结束此修改',exact:true}).click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await waitForProbe(page,async id=>!(await probe.commands()).some(row=>row.operationId===id),conflict);
  const archived=await page.evaluate(id=>probe.get('_historyTransactions',`learning:${id}`),conflict);
  assert.equal(archived.command.request.edits[0].value.title,'Stale device A');
  await waitForProbe(page,async id=>(await probe.commands()).find(row=>row.operationId===id)?.state==='conflict',dependent);

  // Adapters above are not a substitute for clicking the actual producers.
  await verifyTruthProducerUI(second, { records, store, owner, directory });
  await second.evaluate(()=>probe.flush());
  const studySnapshot = await second.evaluate(()=>probe.studySnapshot());
  assert.ok(studySnapshot.length > 0);
  await second.evaluate(expected=>probe.clearStudy(expected,'clear-study-original-remote'),studySnapshot);
  assert.deepEqual(records.studyDays(owner),[],'typed Remote admits the complete snapshot clear');
  await second.evaluate(async()=>{await probe.stableStudy('study-after-clear-remote',2);await probe.drain();await probe.flush();});
  await second.evaluate(expected=>probe.clearStudy(expected,'clear-study-original-remote'),studySnapshot);
  assert.equal(records.get(owner,'studyDays','2026-11-05').seconds,2,'original clear receipt leaves later increments intact through Remote');
  assert.deepEqual(await page.evaluate(()=>probe.hashAccountFence()),{error:'client_account_changed',leaked:0});

  // Existing rigorous fixture checks all 8MiB+17 bytes, no source writes, lazy
  // listing and A→B→A stale callbacks. This is executed now, not cited history.
  const recovery=await verifyExecutorRecovery(page,owner);
  assert.equal(recovery.size,8*1024*1024+17);
  await page.evaluate(() => probe.showHistory(false));
  await page.getByRole('heading',{name:'历史数据恢复'}).waitFor();
  assert.equal(await page.getByText('执行器结果待核对').count(),0);
  await page.evaluate(()=>probe.locale('en-US'));
  await page.getByRole('heading',{name:'Historical data recovery'}).waitFor();
  await page.getByRole('button',{name:'View details',exact:true}).first().click();
  await page.getByRole('button',{name:'Export backup',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify({browser:process.env.BROWSER??'chromium',browserVersion:(browser??context.browser()).version(),profileMode:engine===webkit?'isolated-persistent':'isolated-private',narrow:!!process.env.NARROW,passed:true,recovery,producerUI:JSON.parse(fs.readFileSync(path.join(directory,'producer-ui.json'),'utf8')),cases:['two-device-conflict','independent-feed','causal-blocking','lost-response','reload-multi-tab','readonly-cache','generation-rebuild','tombstone','draft-blob','session-fork-delete','atomic-skill-package','card-review','handout-reading','annotation-undo-stable-id','annotation-provider-offline-multiple-strokes-reload-convergence','conflict-ui-archive-dependent-recheck','guest-delta-dedup-and-id-reuse-rejection','pending-blob-rebuild-and-upload','legacy-original-transaction-conversion','legacy-byte-export','same-key-new-metadata-evidence','account-fences','real-chat-skills-cards-ui']},null,2));
  console.log(`PASS single-source production adapters (${process.env.BROWSER??'chromium'}): ${directory}`);
} finally { for (const context of contexts) await context.close(); await browser?.close(); await web?.close(); store?.close(); await app.close(); }
