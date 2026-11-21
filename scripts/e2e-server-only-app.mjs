/** Full authenticated entry and lazy routes, rather than isolated components. */
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-only-app-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, page;
const evidence = { errors: [], failedModules: [], routes: [] };
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false,
      proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const password = 'server-only-full-app-123';
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  assert.equal((await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password } })).status(), 200);
  page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && /\/src\//.test(response.url())) evidence.failedModules.push(response.url()); });
  const historyRequests = [];
   page.on('request', request => { if (/\/src\/cloud\/(HistoryRecovery|LocalHistoryExport|LibraryImportFiles|legacy-migration|migrate)\./.test(request.url())) historyRequests.push(request.url()); });
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  evidence.routes.push('authenticated main entry / course chat');
   assert.deepEqual(historyRequests, [], 'normal authenticated boot must not load historical recovery');
   // Reproduce a browser with many retained resource commands. Normal routes
   // must neither display their diagnostic controls nor discard/replay them.
   await page.evaluate(async () => {
     const { db } = await import('/src/store/db.ts');
     await db.table('_cloudMeta').bulkPut(Array.from({ length: 39 }, (_, index) => {
       const operationId = `resource-retained-${index}`;
       return { id: `resource-command:${operationId}`, value: { state: 'review', request: {
         operationId, operation: { kind: 'saveProjectText', projectId: 'retained-project', path: `original-${index}.md`, text: `retained draft ${index}`, expectedRevision: null },
       } } };
     }));
   });
   await page.reload();
   await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
   assert.equal(await page.getByRole('region', { name: '资源命令恢复', exact: true }).count(), 0);
  await page.evaluate(() => { location.hash = '/library'; });
  await page.getByTestId('resource-list').waitFor({ timeout: 30000 });
   evidence.routes.push('resource library');
   assert.equal(await page.getByRole('button', { name: /核对资源原命令/ }).count(), 0, 'library must not be flooded by recovery commands');
  await page.evaluate(() => { location.hash = '/settings/assistant'; });
  await page.getByRole('dialog').waitFor();
  await page.getByTestId('card-agent-instructions').waitFor();
  assert.equal(await page.getByTestId('settings-nav-live').count(), 0, 'retired live sharing must not appear in desktop settings');
  evidence.routes.push('assistant settings');
  await page.evaluate(() => { location.hash = '/settings/models'; });
  await page.getByTestId('card-context-compression').waitFor();
  evidence.routes.push('model settings / server compression');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const { closeSettings, openSettings } = await import('/src/components/settingsDialogStore.ts');
    closeSettings();
    openSettings();
  });
  await page.getByTestId('settings-root').waitFor();
  assert.equal(await page.getByTestId('settings-nav-live').count(), 0, 'retired live sharing must not appear in mobile settings');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { location.hash = '/settings/live'; });
  await page.getByTestId('card-context-compression').waitFor();
  evidence.routes.push('retired settings deep link falls back to models');
  await page.evaluate(() => { location.hash = '/settings/data'; });
   await page.getByTestId('cloud-sync-card').waitFor();
   assert.equal(await page.getByTestId('cloud-history-recovery').count(), 0);
   assert.equal(await page.getByText('旧版浏览器数据', { exact: true }).count(), 0);
   assert.equal(await page.getByRole('button', { name: '核对导入文件', exact: true }).count(), 0);
   assert.equal(await page.getByTestId('resource-save-status').count(), 0, 'old drafts alone must not show save status');
   const duplicate = await page.evaluate(async () => {
     const { db } = await import('/src/store/db.ts');
     const { resourceCommand, uploadResource } = await import('/src/client/resources.ts');
     const { id } = await resourceCommand({ kind: 'createFolder', name: 'Duplicate upload fixture' });
     const name = 'cache-blob.webp';
     const canvas = document.createElement('canvas');
     const drawing = canvas.getContext('2d');
     const makeImage = async color => {
       drawing.fillStyle = color;
       drawing.fillRect(0, 0, canvas.width, canvas.height);
       return new Promise(resolve => canvas.toBlob(resolve, 'image/webp'));
     };
     const original = await makeImage('red');
     const replacement = await makeImage('blue');
     await uploadResource(id, name, original);
     try {
       await uploadResource(id, name, replacement);
       throw new Error('Duplicate upload should have failed');
     } catch (error) {
       if (error.code !== 'project_file_exists') throw error;
       const retained = await db.table('_cloudMeta').get(`resource-command:${error.operationId}`);
       return { id, name, operationId: error.operationId, state: retained.value.state,
         original: Array.from(new Uint8Array(await original.arrayBuffer())),
         replacement: Array.from(new Uint8Array(await replacement.arrayBuffer())),
         retained: Array.from(new Uint8Array(await retained.value.blob.arrayBuffer())),
       };
     }
   });
   assert.equal(duplicate.state, 'conflict');
   assert.deepEqual(duplicate.retained, duplicate.replacement, 'the rejected upload retains the original draft bytes');
   const file = await context.request.get(`${origin}/api/v1/projects/${duplicate.id}/download?path=${duplicate.name}`);
   assert.equal(file.status(), 200);
   assert.deepEqual(await file.body(), Buffer.from(duplicate.original), 'the server file is not overwritten');
   const saveStatus = page.getByTestId('resource-save-status');
   await saveStatus.waitFor();
   const activity = page.getByTestId('cloud-activity');
   assert.equal(await activity.count(), 1, 'the global activity surface is mounted');
   assert.equal(await activity.getByText(duplicate.name, { exact: false }).count(), 0);
   assert.equal(await activity.getByText('查看未保存的资料', { exact: true }).count(), 0);
   assert.equal(await activity.getByRole('button', { name: '收起提醒', exact: true }).count(), 0);
   const resourceWrites = [];
   page.on('request', request => { if (/\/api\/clientRuntime\/resourceCommand$/.test(request.url())) resourceWrites.push(request.url()); });
   await saveStatus.getByRole('button', { name: '查看保存详情', exact: true }).click();
   await page.locator(`button[data-operation-id="${duplicate.operationId}"]`).waitFor();
   assert.equal(await page.locator('button[data-operation-id]').count(), 1, 'only current saves appear in the details');
   assert.deepEqual(historyRequests, [], 'settings must not load legacy recovery or import code');
   assert.deepEqual(resourceWrites, [], 'opening save details must not replay file operations');
   evidence.routes.push('data settings / current save details only');
   await saveStatus.getByRole('button', { name: '关闭保存详情', exact: true }).click();
   assert.equal(await page.locator('button[data-operation-id]').count(), 0);
   assert.equal(await page.evaluate(async () => {
     const { db } = await import('/src/store/db.ts');
     const rows = await db.table('_cloudMeta').where('id').startsWith('resource-command:resource-retained-').toArray();
     if (rows.some(row => row.value.request.operation.text !== `retained draft ${row.value.request.operationId.split('-').at(-1)}`)) throw new Error('original draft changed');
     return rows.length;
   }), 39, 'closing recovery must retain every original draft');
  assert.deepEqual(evidence.failedModules, []);
  assert.deepEqual(evidence.errors, []);
   console.log(`PASS authenticated full app, lazy routes/settings and current save details: ${directory}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(directory, 'failure.html'), await page.content());
  }
  throw error;
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await web?.close(); await app.close();
}
