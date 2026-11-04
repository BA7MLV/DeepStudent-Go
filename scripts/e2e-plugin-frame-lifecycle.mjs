import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Real production React host + shipped sandbox document. Only domain I/O is
// in-memory here: this regression isolates document ownership, not Remote auth.
const html = fs.readFileSync('docs/plugins/templates/material-note/views/main.html', 'utf8');
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '/src/i18n';
import { PluginFrame } from '/src/board/PluginFrame.tsx';
let revision = 1, data = { notes: {} }, listeners = 0, watchers = 0, methods = [], held = [];
const root = createRoot(document.getElementById('root'));
const context = { materialId: 'a', width: 1440, revision: 'a:initial' };
const adapter = { identity: 'frame-probe', htmlPath: '/plugins/probe/views/main', context,
  async call(method, args) {
    methods.push(method);
    if (method === 'held') return new Promise(resolve=>held.push(resolve));
    if (method === 'state.read') return { content: JSON.stringify(data), revision };
    if (method === 'state.write') { await new Promise(resolve => setTimeout(resolve, 20)); data = args.data; return { content: JSON.stringify(data), revision: ++revision }; }
    throw new Error('unexpected_method:' + method);
  }, subscribe() { listeners++; return () => listeners--; },
  watchTask() { watchers++; return () => watchers--; },
};
let incarnation = 0;
const framePlugin = { id: 'probe', path: '', revision: 1, manifest: { apiVersion: 1, id: 'probe', name: 'Lifecycle probe', version: '1', enabled: true, entry: 'main.html', capabilities: [], height: 640 } };
const render = () => root.render(React.createElement(React.StrictMode, null, React.createElement(BrowserRouter, null,
  React.createElement(PluginFrame, { key: incarnation, adapter, plugin: { id: 'probe', path: '', revision: 1,
    manifest: { apiVersion: 1, id: 'probe', name: 'Lifecycle probe', version: '1', enabled: true, entry: 'main.html', capabilities: [], height: 640 } } }))));
window.probe = { render, unmount() { root.render(null); }, remount() { incarnation++; render(); },
  context(width) { adapter.context = { ...adapter.context, width, revision: 'a:' + width }; render(); },
  diagnostics: () => ({ listeners, watchers, methods, data }),
  releaseHeld:()=>held.splice(0).forEach(resolve=>resolve({late:true})),
  placements:()=>root.render(React.createElement(React.StrictMode,null,React.createElement(BrowserRouter,null,...['board','side','page'].map(id=>React.createElement(PluginFrame,{key:id,plugin:framePlugin,adapter:{...adapter,identity:'placement-'+id}}))))),
  disposeDocument:()=>{const frame=document.querySelector('iframe');const channel=JSON.parse(frame.srcdoc.match(/const channel=("[^"]+")/)[1]);frame.contentWindow.postMessage({channel,lifecycle:'dispose'},'*');},
};
render();
`;
const web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
  plugins: [{ name: 'frame-lifecycle-fixture',
    resolveId: id => id === '/__frame-entry.js' ? '\0frame-lifecycle-fixture' : undefined,
    load: id => id === '\0frame-lifecycle-fixture' ? fixture : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url === '/__frame') { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__frame-entry.js"></script>'); }
      else if (req.url === '/api/v1/plugins/probe/views/main') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ revision: 1, html })); }
      else next();
    }); },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
let browser;
try {
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${web.resolvedUrls.local[0]}__frame`);
  const note = page.frameLocator('iframe[title="Lifecycle probe"]');
  for (let i = 0; i < 100; i++) {
    await note.locator('#note:not([disabled])').waitFor({ timeout: 30000 });
    await note.getByLabel('本资料笔记').fill(`draft-${i}`);
    await page.evaluate(width => probe.context(width), i % 2 ? 1440 : 1200);
    await note.getByRole('button', { name: '保存到共享实例' }).click();
    await note.getByText('已保存', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => probe.diagnostics().listeners), 1);
    await page.evaluate(() => probe.unmount());
    await page.locator('iframe').waitFor({ state: 'detached' });
    await page.waitForFunction(() => probe.diagnostics().listeners === 0);
    if (i < 99) await page.evaluate(() => probe.remount());
  }
  assert.equal(await page.evaluate(() => probe.diagnostics().data.notes.a), 'draft-99');
  await page.evaluate(()=>probe.placements());
  const placements = [];
  for (let i=0;i<3;i++) {
    const placement = await (await page.locator('iframe').nth(i).elementHandle()).contentFrame();
    await placement.locator('#note:not([disabled])').waitFor();
    await placement.evaluate(index=>plugin.draft.write({text:'placement-'+index}),i);
    placements.push(placement);
  }
  for (let i=0;i<3;i++) assert.deepEqual(await placements[i].evaluate(()=>plugin.draft.read()),{text:'placement-'+i});
  await page.evaluate(()=>probe.unmount());
  await page.waitForFunction(()=>probe.diagnostics().listeners===0);
  await page.evaluate(()=>probe.remount());
  await note.locator('#note:not([disabled])').waitFor();
  const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
  await frame.evaluate(()=>{
    window.disposal=[];
    plugin.call('held').then(()=>disposal.push('unexpected-result'),error=>disposal.push(error.message));
    plugin.tasks.wait('durable').then(()=>disposal.push('unexpected-task'),error=>disposal.push(error.message));
  });
  await page.waitForFunction(()=>probe.diagnostics().watchers===1);
  await page.evaluate(()=>probe.disposeDocument());
  await frame.waitForFunction(()=>disposal.length===2);
  assert.deepEqual(await frame.evaluate(()=>disposal),['plugin_scope_expired','plugin_scope_expired']);
  await page.evaluate(()=>{probe.unmount();probe.releaseHeld();});
  await page.waitForFunction(()=>probe.diagnostics().watchers===0 && probe.diagnostics().listeners===0);
  assert.equal(await page.evaluate(()=>probe.diagnostics().methods.includes('tasks.cancel')),false);
  assert.deepEqual(errors, []);
  console.log('PASS: production PluginFrame + shipped material-note, StrictMode, async HTML load, resize/save and 100 mount/unmount cycles, subscription baseline restored');
} finally { await browser?.close(); await web.close(); }
