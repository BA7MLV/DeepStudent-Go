import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/plugin-command-seams-');
Object.assign(process.env, { NODE_ENV:'test', CLOUD_WORKER_DISABLED:'1', DATA_DIR:directory, FILES_DIR:path.join(directory,'files'), BOOTSTRAP_SECRET_FILE:path.join(directory,'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath:path.join(directory,'db.sqlite') });
let web, browser, store;
try {
  const api = await app.listen({ host:'127.0.0.1',port:0 });
  const fixture = `
import {cloud} from '/src/cloud/state.ts';
import {readRendererPluginCatalog,saveRendererPluginLayout,runRendererPluginAction} from '/src/client/plugin-renderer-commands.ts';
import {disposeServerRuntime} from '/src/client/bootstrap.ts';
cloud.enabled=true;cloud.userId=window.owner;
window.probe={async verify(){
  const catalog=await readRendererPluginCatalog();
  const layout=JSON.parse(catalog.layout.content);
  layout.instances.push({id:'command-seam',pluginId:'flashcards',scope:{kind:'material',id:'command-material'}});
  await saveRendererPluginLayout(JSON.stringify(layout),catalog.layout.content,catalog.layout.revision);
  const after=await readRendererPluginCatalog();
  const plugin=after.plugins.find(p=>p.id==='flashcards');
  const result=await runRendererPluginAction({pluginId:plugin.id,instanceId:'command-seam',revision:plugin.revision},'list',{materialId:'command-material'});
  let conflict=false;try{await saveRendererPluginLayout(JSON.stringify(layout),catalog.layout.content,catalog.layout.revision);}catch(error){conflict=error.code==='client/conflict';}
  return {result,conflict,instances:JSON.parse(after.layout.content).instances.filter(i=>i.id==='command-seam').length};
},dispose:disposeServerRuntime};`;
  web=await createServer({root:path.resolve('apps/web'),configFile:path.resolve('apps/web/vite.config.ts'),cacheDir:path.join(directory,'vite-cache'),plugins:[{name:'command-seams',resolveId:id=>id==='/__commands.js'?'\0commands':undefined,load:id=>id==='\0commands'?fixture:undefined,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/__commands')return next();res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/__commands.js"></script>');});}}],server:{host:'127.0.0.1',port:0,watch:null,hmr:false,proxy:{'/api':{target:api,ws:true,changeOrigin:false}}}});
  await web.listen(); const origin=web.resolvedUrls.local[0].replace(/\/$/,'');
  browser=await chromium.launch({headless:true}); const context=await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`,{headers:{'x-bootstrap-secret':fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE,'utf8').trim()},data:{adminPassword:'command-seam-password-123'}})).status(),201);
  const login=await context.request.post(`${origin}/api/v1/auth/password/login`,{data:{password:'command-seam-password-123'}});
  assert.equal(login.status(),200); const owner=(await login.json()).user.id;
  await context.addInitScript(owner=>{window.owner=owner;},owner);
  store=new DatabaseStore(path.join(directory,'db.sqlite'),path.join(directory,'files/system-files'));
  new CloudRecords(store).apply(owner,[{id:'material',table:'videos',key:'command-material',before:null,after:{id:'command-material',name:'Command fixture',kind:'material',status:'transcribed'}}]);
  const page=await context.newPage(), errors=[], requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>requests.push(new URL(request.url()).pathname));
  await page.goto(`${origin}/__commands`); await page.waitForFunction(()=>!!window.probe);
  const result=await page.evaluate(()=>probe.verify());
  assert.equal(result.instances,1); assert.equal(result.conflict,true); assert.deepEqual(result.result.cards,[]);
   assert.ok(requests.includes('/api/clientRuntime/command'), JSON.stringify(requests));
   assert.ok(requests.includes('/api/clientRuntime/savePluginLayout'), JSON.stringify(requests));
   assert.ok(!requests.includes('/api/v1/plugins/layout'));
  assert.ok(!requests.some(url=>/\/instances\/.*\/actions\//.test(url)));
  assert.deepEqual(errors,[]); await page.evaluate(()=>probe.dispose());
  fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify({result,requests,errors},null,2));
  console.log(`PASS production renderer catalog/CAS/named action command seams, typed command not legacy action URL, stale CAS rejected; evidence ${directory}`);
} finally {await browser?.close();await web?.close();store?.close();await app.close();}
