/** Real HTTP/API and browser lifecycle; only the model responses are mocked. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { scannedPdf } from './fixtures/scanned-pdf.mjs';
import { verifyExecutorRecovery } from './fixtures/executor-recovery.mjs';

const directory=fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/server-task-e2e-');
Object.assign(process.env,{NODE_ENV:'test',DATA_DIR:directory,FILES_DIR:path.join(directory,'files'),BOOTSTRAP_SECRET_FILE:path.join(directory,'bootstrap-secret')});
delete process.env.CLOUD_WORKER_DISABLED;
const {buildServer}=await import('../apps/api/src/server.ts');
const {DatabaseStore}=await import('../apps/api/src/storage/database.ts');
const {CloudRecords}=await import('../apps/api/src/cloud/records.ts');
const {CloudConfiguration}=await import('../apps/api/src/cloud/config.ts');
const {receiveFile}=await import('../apps/api/src/cloud/files.ts');
const {PluginFiles}=await import('../apps/api/src/plugins/files.ts');
let release, entered=false, modelCalls=0;
const gate=new Promise(resolve=>{release=resolve;});
const model=http.createServer(async(req,res)=>{
  try {
    let body='';for await(const chunk of req)body+=chunk;
    modelCalls++;
    if(req.url==='/v1/audio/transcriptions') {entered=true;await gate;res.setHeader('content-type','application/json');res.end(JSON.stringify({text:'关闭所有浏览器页面后完成的课程字幕。'}));return;}
    const prompt=JSON.stringify(JSON.parse(body).messages);
    const content=prompt.includes('本次仅提取第')?'```quiz\n'+JSON.stringify({questions:[{stem:'1. 扫描原题',options:['甲','乙'],answer:0,explanation:'扫描原文答案',answerSource:'original',source:{courseId:'pdf',name:'scan.pdf',page:1}}]})+'\n```':prompt.includes('blocks')?JSON.stringify({blocks:[{type:'para',text:'独立服务器生成的图文讲义。'},{type:'figure',time:'00:00',caption:'来源画面'}]}):prompt.includes('sections')?JSON.stringify({title:'服务器讲义',summary:'真实来源',sections:[{heading:'第一节',start:'00:00',end:'00:02',points:['来源']}] }):'类型：课件\n真实课程画面';
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]}));
  }catch(error){res.statusCode=500;res.end(String(error));}
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
const modelOrigin=`http://127.0.0.1:${model.address().port}`;
const app=buildServer({dbPath:path.join(directory,'db.sqlite'),fetch:(url,init)=>{
  const address=new URL(String(url));assert.equal(address.origin,'https://model.invalid','no real provider/network calls');
  return fetch(modelOrigin+address.pathname,init);
}});
let web,browser,store;
async function until(predicate){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,25));}throw new Error('e2e_timeout');}
try {
  const api=await app.listen({host:'127.0.0.1',port:0});
  web=await createServer({root:path.resolve('apps/web'),configFile:path.resolve('apps/web/vite.config.ts'),cacheDir:path.join(directory,'vite-cache'),server:{host:'127.0.0.1',port:0,watch:null,hmr:false,proxy:{'/api':{target:api,ws:true,changeOrigin:false}}}});
  await web.listen();const origin=web.resolvedUrls.local[0].replace(/\/$/,'');
  browser=await chromium.launch({headless:true});const context=await browser.newContext();
  const setup=await context.request.post(origin+'/api/v1/bootstrap/initialize',{headers:{'x-bootstrap-secret':fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE,'utf8').trim()},data:{adminPassword:'server-task-test-password-123'}});assert.equal(setup.status(),201,await setup.text());
  const login=await context.request.post(origin+'/api/v1/auth/password/login',{data:{password:'server-task-test-password-123'}});assert.equal(login.status(),200);
  const owner=(await login.json()).user.id;
  const cookies=(await context.cookies()).map(c=>`${c.name}=${c.value}`).join('; ');
  store=new DatabaseStore(path.join(directory,'db.sqlite'),path.join(directory,'files/system-files'));
  const records=new CloudRecords(store),config=new CloudConfiguration(store,directory);
  config.save(owner,{...config.get(owner),providers:[{id:'mock',name:'Mock',protocol:'openai-chat',apiKey:'mock-only',baseUrl:'https://model.invalid/v1',catalogId:'',serves:['chat','vision','asr']}],llmModel:{providerId:'mock',model:'mock'},visionModel:{providerId:'mock',model:'mock'},asrModel:{providerId:'mock',model:'mock'}});
  const put=(table,key,after)=>records.apply(owner,[{id:crypto.randomUUID(),table,key,before:records.get(owner,table,key),after}]);
  const video=path.join(directory,'source.mp4');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x180:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','mpeg4','-c:a','aac','-shortest',video]);
  for(const [id,name,bytes,extra] of [['video','source.mp4',fs.readFileSync(video),{}],['pdf','scan.pdf',await scannedPdf(),{kind:'material',materialFormat:'pdf'}],['html','source.html',Buffer.from('<html><body><main>真实HTML材料正文。</main></body></html>'),{kind:'material',materialFormat:'html'}]]) {
    const file=await receiveFile(store,process.env.FILES_DIR,owner,Readable.from([bytes]),name,'application/octet-stream',bytes.length,bytes.length);
    put('videos',id,{id,name,duration:2,...extra});put('courseFiles',id,{id,fileId:file.id});
  }
  const pluginFiles=new PluginFiles(store),layout=pluginFiles.layout(owner),placements=JSON.parse(layout.content);
  placements.instances.push({id:'extract-pdf',pluginId:'practice',scope:{kind:'material',id:'pdf'}});
  pluginFiles.save(owner,layout.path,JSON.stringify(placements),layout.content,layout.revision);
  const page=await context.newPage(),requests=[];
  context.on('request',req=>{if(req.url().includes('/api/'))requests.push(req.url());});
  await page.goto(origin);await page.waitForLoadState('domcontentloaded');
  const jobs=await page.evaluate(async()=>{
    const jobs=[];
    for(const [kind,videoId,input] of [['transcribe','video',{}],['handout','video',{}],['cover','video',{}],['material','html',{format:'html'}],['material','pdf',{format:'pdf'}],['cover','pdf',{}]]) {
      const response=await fetch('/api/v1/cloud/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce:crypto.randomUUID(),kind,resource:`course:${videoId}`,input:{videoId,...input}})});
      const body=await response.json();if(!response.ok)throw new Error(JSON.stringify(body));jobs.push(body.id);
    }
    const extraction=await fetch('/api/v1/plugins/practice/instances/extract-pdf/actions/extract',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:1,args:{materialId:'pdf',clientNonce:'close-browser-scan'}})});
    const result=await extraction.json();if(!extraction.ok)throw new Error(JSON.stringify(result));jobs.push(result.id);
    return jobs;
  });
  await until(()=>entered);
  await context.close();await browser.close();browser=undefined;
  release(); // No browser, iframe, JS realm or WS remains to execute the tasks.
  await until(()=>{store.db.prepare("UPDATE cloud_permissions SET status='approved' WHERE owner_id=? AND status='pending'").run(owner);return jobs.every(id=>['completed','failed'].includes(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(id).status));});
  for(const id of jobs){const row=store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id);assert.equal(row.status,'completed',JSON.stringify(row));assert.equal(row.executor,'node');}
  assert.ok(records.get(owner,'covers','video').blob.$file);
  assert.ok(records.get(owner,'covers','pdf').blob.$file);
  assert.ok(records.get(owner,'videos','__course_questions__pdf'),'scanned PDF bank saved after browser shutdown');
  assert.ok(store.db.prepare("SELECT 1 FROM cloud_records WHERE owner_id=? AND table_name='handouts' AND value IS NOT NULL").get(owner));
  for(const route of ['/api/v1/cloud/worker/claim','/api/v1/cloud/tasks/old/authorize','/api/v1/cloud/tasks/old/authorize/finish']) {
    const response=await fetch(api+route,{method:'POST',headers:{cookie:cookies,origin:api,'content-type':'application/json',authorization:'Bearer retired-task-token'},body:'{}'});assert.equal(response.status,404,route);
  }
  browser=await chromium.launch({headless:true});const reopened=await browser.newContext();await reopened.addCookies((await (async()=>{const c=[];for(const part of cookies.split('; ')){const n=part.indexOf('=');c.push({name:part.slice(0,n),value:part.slice(n+1),url:origin});}return c;})()));
  const view=await reopened.newPage(),idle=[];reopened.on('request',req=>{if(/\/api\//.test(req.url()))idle.push(req.url());});
  await view.goto(origin);await view.waitForTimeout(3000);idle.length=0;const callsBeforeIdle=modelCalls;
  await view.waitForTimeout(60000);
  assert.equal(await view.locator('iframe[src*="cloud-worker"]').count(),0);
  assert.deepEqual(idle.filter(url=>/\/worker\/claim|\/authorize|\/tasks(?:\/|\?|$)/.test(url)),[],'60s idle has no executor or task polling');
  assert.equal(modelCalls,callsBeforeIdle);
  assert.deepEqual(requests.filter(url=>/cloud-worker|\/worker\/claim|\/authorize/.test(url)),[]);
  console.log('Recovery fixture:',await verifyExecutorRecovery(view,owner));
  console.log('PASS real API + HTTP mock: browser closes during ASR; transcribe/illustrated handout/cover/HTML/scanned PDF/original questions complete on server; retired routes 404; idle60 without polling; lazy read-only legacy Blob export and account-generation guards.');
} finally {release();await browser?.close();await web?.close();store?.close();await app.close();await new Promise(resolve=>model.close(resolve));}
