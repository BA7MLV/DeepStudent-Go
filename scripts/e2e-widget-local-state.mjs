// Real browser IndexedDB + projection-only middleware + production WidgetBlock.
// Sources are fixture projections; no server is needed or contacted by this test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/widget-local-state-');
const html = `<section><output></output><button id="next">下一步</button><button id="special">特殊型</button><span id="error"></span></section>
<script>(()=>{
const api=window.__wbw; let mode='std',step=0;window.restores=0;
const output=document.querySelector('output');
function paint(){output.textContent=mode+':'+step;}
function save(){api.setWidgetState({modelContent:{mode,step},privateContent:{panel:'LOCAL_ONLY'}}).catch(e=>document.querySelector('#error').textContent=e.message);}
function restore(){const s=api.widgetState?.modelContent;mode=s?.mode??'std';step=s?.step??0;paint();}
document.querySelector('#next').onclick=()=>{step++;paint();save();};
document.querySelector('#special').onclick=()=>{mode='sp';step=0;paint();save();};
window.addEventListener('wbw:statechange',()=>{window.restores++;restore();});restore();
})();</script>`;
const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';
import WidgetBlock from '/src/components/WidgetBlock.tsx';
import {db,useCloudDatabase} from '/src/store/db.ts';
import {cloudTransaction} from '/src/cloud/transactions.ts';
import {markCloudApply} from '/src/cloud/cache.ts';
import {accountLifetime} from '/src/client/account-lifecycle.ts';
import {openWidgetSession,readWidgetState,saveWidgetState} from '/src/store/widgetState.ts';
import '/src/i18n';
const html=${JSON.stringify(html)};
const payload={id:'visual-1',ref:'visual-1',kind:'html',schemaVersion:1,revision:1,source:'tool',html};
const root=createRoot(document.querySelector('main'));
async function project(row){await cloudTransaction(db,[db.chats],async()=>{markCloudApply();await db.chats.put(row);});}
async function setAccount(owner){
 useCloudDatabase(owner);accountLifetime(owner);
 if(!await db.chats.get(1)){
  const row={id:1,sessionId:1,videoId:'course',role:'assistant',content:'fixture',createdAt:1,widget:payload,
   widgetStates:{'visual-1':{modelContent:{mode:'std',step:0},privateContent:null}}};
  await project(row);await project({...row,id:2,widgetStates:undefined});
  await project({...row,id:3,widget:{html},widgetStates:undefined});
 }
}
async function render(id=1){const row=await db.chats.get(id);root.render(React.createElement(WidgetBlock,{key:db.name+':'+id,rowId:id,payload:row.widget,dark:false,allowPopout:false}));}
window.probe={get db(){return db;},setAccount,render,project,openWidgetSession,readWidgetState,saveWidgetState};
await setAccount('local-widget-a');await render();document.body.dataset.ready='yes';`;
let web, browser;
try {
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'cache'), logLevel: 'warn', plugins: [{
      name: 'widget-local-state', resolveId: id => id === '/__local-widget.js' ? '\0local-widget' : undefined,
      load: id => id === '\0local-widget' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== '/__local-widget') return next();
        res.setHeader('content-type', 'text/html'); res.end('<main></main><script type="module" src="/__local-widget.js"></script>');
      }); },
    }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 950 } });
  const networkWrites = [], errors = [];
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) networkWrites.push(request.url()); });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const load = async target => {
    await target.goto(origin + '/__local-widget');
    try { await target.locator('body[data-ready="yes"]').waitFor({ timeout: 30000 }); }
    catch (error) { throw new Error(`${error.message}\nPage errors: ${JSON.stringify(errors)}\n${await target.locator('body').innerText()}`); }
  };
  const frame = () => page.getByTestId('widget-frame').contentFrame();
  const read = () => page.evaluate(async () => {
    const p=probe,row=await p.db.chats.get(1),binding=await p.openWidgetSession(1,row.widget);
    return p.readWidgetState(binding);
  });
  const waitSaved = (mode, step) => page.waitForFunction(async ({mode,step}) => {
    const value=(await probe.db._widgetStates.get([1,'visual-1']))?.state?.modelContent;
    return value?.mode===mode && value?.step===step;
  }, {mode,step});
  await load(page); await frame().locator('output').filter({ hasText: 'std:0' }).waitFor();
  const cloudBefore = await page.evaluate(() => probe.db.chats.get(1));

  // Delay only the ACK after a real local commit (never keep an IDB transaction
  // alive with an artificial timer). This deterministically exposes old echoes.
  await page.evaluate(() => {
    const database=probe.db,transaction=database.transaction;
    let delayed=true;
    database.transaction=function(...args){
      const work=transaction.apply(this,args);
      if(delayed && args[0]==='rw' && args.includes(database._widgetStates)){
        delayed=false;
        return work.then(value=>new Promise(resolve=>{window.releaseSave=()=>resolve(value);}));
      }
      return work;
    };
  });
  await frame().locator('#next').click();
  await page.waitForFunction(() => !!window.releaseSave);
  await frame().locator('#special').click();
  assert.equal(await frame().locator('output').textContent(), 'sp:0');
  await frame().locator('section').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await frame().locator('output').textContent(), 'sp:0', 'earlier committed state must not restore over the newer click');
  await page.evaluate(() => window.releaseSave()); await waitSaved('sp',0);
  assert.equal(await frame().locator('output').textContent(), 'sp:0');
  assert.equal(await frame().locator('section').evaluate(() => window.restores), 0, 'own saves do not trigger restore');
  assert.deepEqual(await page.evaluate(() => probe.db.chats.get(1)), cloudBefore, 'no chat-row mutation');
  assert.equal(await page.evaluate(() => probe.db.table('_learningCommands').count()), 0, 'no cloud command created');

  // Real storage failure rejects the API and preserves the last durable value.
  await page.evaluate(() => {
    const table=probe.db._widgetStates,put=table.put;
    table.put=function(...args){table.put=put;return Promise.reject(new Error('测试：本机空间不足'));};
  });
  await frame().locator('#next').click();
  await frame().locator('#error').filter({hasText:'本机空间不足'}).waitFor();
  assert.equal((await read()).modelContent.step,0);
  await frame().locator('#special').click();await waitSaved('sp',0);

  await context.setOffline(true);
  await frame().locator('#next').click();await waitSaved('sp',1);
  assert.equal((await read()).privateContent.panel,'LOCAL_ONLY');
  await context.setOffline(false);
  await load(page);await frame().locator('output').filter({hasText:'sp:1'}).waitFor();

  // Later server projections, including legacy inline state, cannot overwrite it.
  await page.evaluate(async()=>{
    const row=await probe.db.chats.get(1);
    await probe.project({...row,widgetStates:{'visual-1':{modelContent:{mode:'std',step:88},privateContent:null}}});
  });
  assert.equal((await read()).modelContent.step,1);
  assert.equal(await frame().locator('output').textContent(),'sp:1');

  // Another tab of the same browser shares local storage, not a server channel.
  const sibling=await context.newPage();await load(sibling);
  const siblingFrame=sibling.getByTestId('widget-frame').contentFrame();
  await siblingFrame.locator('output').filter({hasText:'sp:1'}).waitFor();
  await siblingFrame.locator('#next').click();await waitSaved('sp',2);
  await frame().locator('output').filter({hasText:'sp:2'}).waitFor();await sibling.close();

  // Id-less legacy opening is local too; identical HTML in other rows is isolated.
  const isolation=await page.evaluate(async()=>{
    const p=probe,legacyRow=await p.db.chats.get(3),before=JSON.stringify(legacyRow);
    const legacy=await p.openWidgetSession(3,legacyRow.widget);
    await p.saveWidgetState(legacy,{modelContent:{step:5}});
    const reopened=await p.openWidgetSession(3,(await p.db.chats.get(3)).widget);
    const other=await p.openWidgetSession(2,(await p.db.chats.get(2)).widget);
    return {unchanged:before===JSON.stringify(await p.db.chats.get(3)),legacy:await p.readWidgetState(reopened),other:await p.readWidgetState(other)};
  });
  assert.ok(isolation.unchanged);assert.equal(isolation.legacy.modelContent.step,5);assert.equal(isolation.other,null);
  await page.evaluate(async()=>{await probe.setAccount('local-widget-b');await probe.render();});
  await frame().locator('output').filter({hasText:'std:0'}).waitFor();
  assert.equal((await read()).modelContent.step,0,'different accounts have isolated snapshots');
  await page.evaluate(async()=>{await probe.setAccount('local-widget-a');await probe.render();});
  // Account changes normally remount the entire application; force a new fixture root key.
  await load(page);await frame().locator('output').filter({hasText:'sp:2'}).waitFor();
  assert.deepEqual(networkWrites,[],'no API requests for local persistence or restore');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(directory,'local-widget.png')});
  console.log('PASS: real local-only IDB, offline save, reload, rapid-click echo suppression, failed save/retry, tab sharing, legacy and account/row isolation:',directory);
} finally {
  await browser?.close();await web?.close();
}
