/** Retired browser show_widget/assistantSnapshot executor coverage is now run by
 * e2e-server-widgets below (real save-before-display, partial args, reload, QA,
 * local controls and continuation). This source fixture retains complex DOM
 * recovery and exercises production widget-state/edit commands against real API.
 * No external BASE_URL or existing user profile is used. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const directory=fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/widget-protocol-');
Object.assign(process.env,{NODE_ENV:'test',DATA_DIR:directory,FILES_DIR:path.join(directory,'files'),BOOTSTRAP_SECRET_FILE:path.join(directory,'secret'),CLOUD_WORKER_DISABLED:'1'});
const {buildServer}=await import('../apps/api/src/server.ts');
const {DatabaseStore}=await import('../apps/api/src/storage/database.ts');
const {CloudRecords}=await import('../apps/api/src/cloud/records.ts');
const app=buildServer({dbPath:path.join(directory,'db.sqlite')});
let web,browser,store;
try {
 const api=await app.listen({host:'127.0.0.1',port:0});
 const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';
import WidgetBlock from '/src/components/WidgetBlock.tsx';import {FeedbackHost} from '/src/ui/feedback.tsx';
import {startCloud} from '/src/cloud/sync.ts';import {db} from '/src/store/db.ts';
import {openWidgetSession,readWidgetState,saveWidgetState} from '/src/store/widgetState.ts';
import {persistArtifactEdit} from '/src/store/artifactEdit.ts';
import {removeConversationMessage} from '/src/store/conversationProducts.ts';
import '/src/i18n';
await startCloud(window.owner);
const root=createRoot(document.getElementById('root'));window.modelRequests=0;
window.renderPayload=(payload)=>root.render(React.createElement(React.Fragment,null,React.createElement(FeedbackHost),React.createElement(WidgetBlock,{payload,dark:false,allowPopout:false,onPrompt:async()=>{window.modelRequests++;}})));
window.probe={db,openWidgetSession,readWidgetState,saveWidgetState,persistArtifactEdit,removeConversationMessage};
document.body.dataset.ready='yes';`;
 web=await createServer({root:path.resolve('apps/web'),configFile:path.resolve('apps/web/vite.config.ts'),cacheDir:path.join(directory,'cache'),plugins:[{
 name:'widget-protocol',resolveId:id=>id==='/__protocol.js'?'\0protocol':undefined,load:id=>id==='\0protocol'?fixture:undefined,
 configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/__protocol')return next();res.setHeader('content-type','text/html');res.end('<main id="root"></main><script type="module" src="/__protocol.js"></script>');});}
 }],server:{host:'127.0.0.1',port:0,watch:null,hmr:false,proxy:{'/api':{target:api,ws:true,changeOrigin:false}}}});
 await web.listen();const origin=web.resolvedUrls.local[0].replace(/\/$/,'');
 browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 const context=await browser.newContext({viewport:{width:1100,height:900},reducedMotion:'reduce'});
 await context.request.post(origin+'/api/v1/bootstrap/initialize',{headers:{'x-bootstrap-secret':fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE,'utf8').trim()},data:{adminPassword:'protocol-password-123456'}});
 const login=await context.request.post(origin+'/api/v1/auth/password/login',{data:{password:'protocol-password-123456'}});assert.equal(login.status(),200);
 const owner=(await login.json()).user.id;
 store=new DatabaseStore(path.join(directory,'db.sqlite'),path.join(directory,'files/system-files'));const records=new CloudRecords(store);
 const put=(table,key,after)=>records.apply(owner,[{id:crypto.randomUUID(),table,key,before:records.get(owner,table,key),after}]);
 const first={id:'first',ref:'first-ref',html:'<p>same source</p>',schemaVersion:1,revision:1},second={...first,id:'second',ref:'second-ref'};
 for(const id of [1,2]){put('chatSessions',id,{id,videoId:'__library_assistant__',title:'Widget test',createdAt:id});put('chats',id,{id,sessionId:id,videoId:'__library_assistant__',role:'assistant',content:'KEEP_TEXT',reasoning:'KEEP_REASON',createdAt:id,widgets:[first,second],widget:second});}
 await context.addInitScript(owner=>{window.owner=owner;},owner);
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/__protocol');await page.locator('body[data-ready="yes"]').waitFor({timeout:60000});
 const stateResult=await page.evaluate(async()=>{
 const {db,openWidgetSession:open,readWidgetState:read,saveWidgetState:save,persistArtifactEdit:edit,removeConversationMessage:remove}=probe;
 const row=await db.chats.get(1),a=await open(1,row.widgets[0]),b=await open(1,row.widgets[1]),other=await open(2,(await db.chats.get(2)).widgets[0]);
 await save(a,{modelContent:{a:1},privateContent:{panel:'PRIVATE_UI_ONLY'}});await save(b,{modelContent:{a:2}});
 const initial=[await read(a),await read(b),await read(other)];
 let invalid=false;try{await save(a,{modelContent:{a:9},rowId:2});}catch{invalid=true;}
 const unchanged=await read(a);
 let wrongSession=false;try{await save({...a,sessionId:999},{modelContent:1});}catch{wrongSession=true;}
 const edited=await edit({rowId:1,kind:'html',location:'widget',widgetId:a.widgetId,source:row.widgets[0].html,next:'<p>edited first</p>',expectedContent:'KEEP_TEXT'});
 let stale=false;try{await save(a,{modelContent:7});}catch{stale=true;}
 const sibling=await read(b),fresh=await open(1,edited.widgets[0]),reset=await read(fresh);
 await remove(1);let deleted=false;try{await save(fresh,{modelContent:8});}catch{deleted=true;}
 return {initial,invalid,unchanged,wrongSession,edited,stale,sibling,reset,deleted,missing:!(await db.chats.get(1))};
 });
 assert.equal(stateResult.initial[0].modelContent.a,1);assert.equal(stateResult.initial[1].modelContent.a,2);assert.equal(stateResult.initial[2],null);
 assert.ok(stateResult.invalid&&stateResult.wrongSession&&stateResult.stale&&stateResult.deleted&&stateResult.missing);
 assert.deepEqual(stateResult.unchanged,stateResult.initial[0]);assert.equal(stateResult.sibling.modelContent.a,2);assert.equal(stateResult.reset,null);
 assert.equal(stateResult.edited.widgets[0].ref,'first-ref');assert.notEqual(stateResult.edited.widgets[0].id,'first');assert.equal(stateResult.edited.widgets[1].id,'second');assert.equal(stateResult.edited.widget.id,'second');assert.equal(stateResult.edited.content,'KEEP_TEXT');assert.equal(stateResult.edited.reasoning,'KEEP_REASON');
 assert.equal(records.get(owner,'chats',1),null,'stale command cannot resurrect deleted server row');
 const render=payload=>page.evaluate(payload=>window.renderPayload(payload),payload);
 await render({html:'<section><h2>无脚本静态作品</h2></section>'});
 const frame=()=>page.getByTestId('widget-frame').contentFrame();
 await frame().getByRole('heading',{name:'无脚本静态作品'}).waitFor();
 const code='<section><label>系数<input type="range" min="1" max="5" value="2"></label><output>2</output></section><script>document.querySelector("section").dataset.run=String(Math.random());document.querySelector("input").oninput=e=>document.querySelector("output").textContent=e.target.value</script>';
 await render({html:code});await frame().getByRole('slider').fill('4');assert.equal(await frame().locator('output').innerText(),'4');
 const token=await frame().locator('section').getAttribute('data-run');await render({html:code});assert.equal(await frame().locator('section').getAttribute('data-run'),token,'same revision does not remount');
 const failing='<section data-run="pending">失败示例</section><script>document.querySelector("section").dataset.run=String(Math.random());throw new Error("初始化示例错误")</script>';
 await render({html:failing});await page.getByTestId('widget-error').waitFor();await page.getByText('运行详情',{exact:true}).click();await page.getByRole('button',{name:'查看 HTML 源码',exact:true}).click();assert.equal(await page.getByTestId('widget-source').textContent(),failing);
 const failedToken=await frame().locator('section').getAttribute('data-run');await page.getByRole('button',{name:'重试预览'}).click();await page.getByTestId('widget-error').waitFor();assert.notEqual(await frame().locator('section').getAttribute('data-run'),failedToken);
 await render({html:'<p>未来版本源码</p>',schemaVersion:99});await page.getByRole('alert').filter({hasText:'协议版本暂不支持'}).waitFor();assert.equal(await page.getByTestId('widget-frame').count(),0);await page.getByRole('button',{name:'查看 HTML 源码'}).click();assert.equal(await page.getByTestId('widget-source').textContent(),'<p>未来版本源码</p>');
 for(const width of [320,1100]){await page.setViewportSize({width,height:900});assert.ok(await page.locator('#root').evaluate(el=>el.scrollWidth<=el.clientWidth+1));}
 await render({html:{corrupt:true},libs:['chart.js']});await page.getByRole('alert').filter({hasText:'作品源码缺失或格式无效'}).waitFor();assert.equal(await page.getByTestId('widget-frame').count(),0);
 assert.equal(await page.evaluate(()=>window.modelRequests),0);
 assert.deepEqual(errors,['初始化示例错误','初始化示例错误'],'only the deliberately thrown initial/retried iframe errors reach pageerror');
 await page.screenshot({path:path.join(directory,'protocol.png')});console.log('PASS protocol DOM recovery/local controls/replay + real server state commands/sibling edit/stale deletion:',directory);
} finally {await browser?.close();await web?.close();await app.close();store?.close();}
// Child exit is propagated. This is delegation, not a skipped legacy assertion.
execFileSync(process.execPath,['--import','tsx',new URL('e2e-server-widgets.mjs',import.meta.url).pathname],{stdio:'inherit',env:{...process.env,CLOUD_WORKER_DISABLED:''}});
