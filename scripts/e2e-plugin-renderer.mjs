import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/plugin-renderer-');
let web, browser;
try {
  const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {pluginRendererDiagnostics,pluginScopeDiagnostics} from '/src/client/plugin-renderer.tsx';
import {PluginHost} from '/src/plugins/PluginHost.tsx';
import {cloud} from '/src/cloud/state.ts';
import {disposeServerRuntime} from '/src/client/bootstrap.ts';
const occurrence = {plugin:{id:'fixture',revision:1,source:'builtin',manifest:{enabled:true,capabilities:[],views:{main:{surfaces:['board.main']}}}},instance:{id:'instance',pluginId:'fixture',scope:{kind:'account'}},placement:{id:'placement',instanceId:'instance',pluginId:'fixture',viewId:'main'},context:{surface:'board.main'}};
const root = createRoot(document.getElementById('root'));
const mount = enabled => flushSync(() => root.render(enabled ? React.createElement(React.StrictMode, null, React.createElement(PluginHost, occurrence)) : null));
const never = new Promise(()=>{});
function Abandon(){throw never;}
window.probe = {diagnostics:pluginRendererDiagnostics,scopes:pluginScopeDiagnostics,mount,
  reset:()=>disposeServerRuntime(),
  availability: enabled => {occurrence.plugin.manifest.enabled=enabled;mount(true);},
  dependency: enabled => {occurrence.plugin.error=enabled?undefined:'plugin_dependency_unavailable';mount(true);},
  crash:()=>{occurrence.plugin.manifest.capabilities=undefined;occurrence.plugin.revision++;mount(true);},
  repair:()=>{occurrence.plugin.manifest.capabilities=[];occurrence.plugin.revision++;mount(true);},
  account: id => {cloud.userId=id;window.dispatchEvent(new Event('wangke:bot-session-ended'));mount(true);},
  three:()=>flushSync(()=>root.render(React.createElement(React.StrictMode,null,...['board','side','page'].map(id=>React.createElement(PluginHost,{...occurrence,key:id,placement:{...occurrence.placement,id}}))))),
  abandoned:()=>flushSync(()=>root.render(React.createElement(React.Suspense,{fallback:React.createElement('p',null,'uncommitted')},React.createElement(PluginHost,occurrence),React.createElement(Abandon))))};
mount(true);
`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory,'cache'),
    plugins: [{name:'renderer-fixture', resolveId:id=>id==='/__renderer.js'?'\0renderer':undefined, load:id=>id==='\0renderer'?fixture:undefined,
      configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/__renderer')return next();res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/__renderer.js"></script>');});}}],
    server:{host:'127.0.0.1',port:0,watch:null,hmr:false} });
  await web.listen(); browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  page.on('console', message=>console.log(message.type(),message.text()));
  page.on('pageerror', error=>console.error(error));
  await page.goto(`${web.resolvedUrls.local[0]}__renderer`);
  try { await page.getByRole('alert').filter({hasText:'内置视图提供者不可用'}).waitFor({timeout:15000}); }
  catch(error){throw new Error(`${error.message}\n${await page.content()}\n${JSON.stringify(await page.evaluate(()=>window.probe?.diagnostics()))}`);}
  assert.equal(await page.locator('[data-slot="wangke.plugin.view"]').count(),1);
  assert.deepEqual(await page.evaluate(()=>probe.scopes()[0].scopes),{account:1,project:1,instance:1,placement:1});
  for (let i=0;i<100;i++) {
    await page.evaluate(()=>probe.mount(false));
    await page.waitForFunction(()=>probe.diagnostics().refs===0 && probe.diagnostics().contexts===0);
    await page.evaluate(()=>probe.mount(true));
    await page.getByRole('alert').filter({hasText:'内置视图提供者不可用'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>probe.diagnostics()),{refs:1,contexts:1});
    const scope = await page.evaluate(()=>probe.scopes()[0]);
    assert.equal(scope.retains,1);
    assert.equal(scope.failures,0);
    assert.deepEqual(scope.scopes,{account:1,project:1,instance:1,placement:1});
  }
  await page.evaluate(()=>probe.three());
  await page.waitForFunction(()=>probe.scopes()[0]?.retains===3);
  assert.deepEqual(await page.evaluate(()=>probe.scopes()[0].scopes),{account:1,project:1,instance:1,placement:3});
  await page.evaluate(()=>probe.mount(true));
  await page.waitForFunction(()=>probe.scopes()[0]?.retains===1);
  await page.evaluate(()=>probe.availability(false));
  await page.waitForFunction(()=>probe.scopes()[0]?.retains===0 && probe.scopes()[0]?.scopes.account===0);
  await page.evaluate(()=>probe.availability(true));
  await page.getByRole('alert').filter({hasText:'内置视图提供者不可用'}).waitFor();
  await page.evaluate(()=>probe.dependency(false));
  await page.waitForFunction(()=>probe.scopes()[0]?.retains===0 && probe.scopes()[0]?.scopes.instance===0);
  await page.evaluate(()=>probe.dependency(true));
  await page.getByRole('alert').filter({hasText:'内置视图提供者不可用'}).waitFor();
  const beforeAccount = await page.evaluate(()=>probe.scopes()[0].fibers.find(f=>f.level==='account').incarnation);
  await page.evaluate(()=>probe.account('account-replacement'));
  await page.waitForFunction(()=>probe.scopes()[0]?.retains===1);
  assert.notEqual(await page.evaluate(()=>probe.scopes()[0].fibers.find(f=>f.level==='account').incarnation),beforeAccount);
  const beforeReset = await page.evaluate(()=>probe.scopes()[0].fibers.find(f=>f.level==='account').incarnation);
  await page.evaluate(()=>probe.reset());
  await page.waitForFunction(before=>probe.scopes()[0]?.retains===1 && probe.scopes()[0]?.fibers.find(f=>f.level==='account')?.incarnation!==before,beforeReset);
  await page.evaluate(()=>probe.crash());
  await page.getByRole('alert').filter({hasText:'插件视图出错'}).waitFor();
  assert.equal(await page.evaluate(()=>probe.scopes()[0].failures),1);
  await page.evaluate(()=>probe.repair());
  await page.getByRole('alert').filter({hasText:'内置视图提供者不可用'}).waitFor();
  await page.evaluate(()=>probe.mount(false));
  await page.waitForFunction(()=>probe.diagnostics().refs===0 && probe.diagnostics().contexts===0);
  await page.evaluate(()=>probe.abandoned());
  await page.getByText('uncommitted',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>probe.diagnostics()),{refs:0,contexts:0});
  assert.deepEqual(await page.evaluate(()=>probe.scopes()),[]);
  await page.evaluate(()=>probe.mount(false));
  console.log('PASS production Cordis root -> typed view outlet -> injected PluginView; StrictMode and 100 committed mount/unmount cycles release all renderer contexts');
} finally {await browser?.close();await web?.close();}
