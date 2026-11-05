import assert from 'node:assert/strict';
import { assertCreationHint, changePlugin, pluginTool } from './plugin-tools.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.join(os.tmpdir(), 'opencode'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'plugin-unplug-ui-'));
const output = path.join(root, 'plugin-pluggability-screenshots'); fs.mkdirSync(output, { recursive: true });
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store, page;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite'), server: { watch: null, hmr: false, host: 'localhost', port: 0, proxy: { '/api': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false, ws: true } } } });
  await web.listen(); const origin = `http://localhost:${web.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { data, headers: { origin, ...headers } });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'unplug-browser-password-123' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const owner = (await (await post('/auth/password/login', { password: 'unplug-browser-password-123' })).json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new PluginFiles(store), records = new CloudRecords(store);
  const material = { id: 'unplug-video', name: '插拔验收视频', kind: 'video', duration: 60, createdAt: Date.now(), status: 'transcribed' };
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'videos', key: material.id, before: null, after: material },
    { id: crypto.randomUUID(), table: 'cards', key: 987, before: null, after: { id: 987, videoId: material.id, time: 1, q: '停用后仍保留的历史卡片', a: '原权威记录不删除', status: 1, createdAt: Date.now() } },
    { id: crypto.randomUUID(), table: 'segments', key: 987, before: null, after: { id: 987, videoId: material.id, idx: 0, start: 0, end: 10, text: '已有真实字幕', status: 1 } }]);
  for (const relative of ['views/main.html', 'manifest.json']) files.save(owner, `/system/plugins/cards-reader/${relative}`, fs.readFileSync(path.resolve('docs/plugins/templates/cards-reader', relative), 'utf8'), '', 0);
  const before = files.layout(owner), layout = JSON.parse(before.content);
  for (const id of ['flashcards', 'practice', 'review', 'material-tools', 'cards-reader']) {
    layout.instances.push({ id: `ui-${id}`, pluginId: id, scope: { kind: 'material', id: material.id } });
    layout.placements.push({ id: `ui-${id}`, pluginId: id, instanceId: `ui-${id}`, viewId: 'main', surface: 'board.main', scope: { kind: 'account' }, order: 20 + layout.placements.length });
  }
  files.save(owner, before.path, JSON.stringify(layout), before.content, before.revision);
  page = await context.newPage(); await page.goto(`${origin}/#/board`);
  await page.getByTestId('board-plugin-flashcards').getByText('停用后仍保留的历史卡片', { exact: true }).waitFor({ timeout: 30000 });
   const openManager = () => assertCreationHint(page);
   const change = (id, action) => changePlugin(page, id, action);
  await openManager();
  // New sandbox implementation calls the same host read without a page branch.
  const replacement = page.getByTestId('board-plugin-cards-reader').frameLocator('iframe[title="替代卡片列表"]');
  await replacement.getByText('停用后仍保留的历史卡片', { exact: false }).waitFor();
  const reader = await context.newPage(); await reader.goto(`${origin}/#/board`); await reader.getByTestId('board-plugin-todo').waitFor();
  await reader.evaluate(async () => { await (await import('/src/cloud/sync.ts')).flushCloud(); });
  await reader.goto(`${origin}/#/player/${material.id}`); await reader.getByTestId('panel-tab-cards').waitFor({ state: 'attached' });
  const toggle = reader.getByTestId('study-assistant-toggle'); if (await toggle.isVisible()) await toggle.click();
  await reader.getByTestId('panel-tab-cards').click(); await reader.getByTestId('cards-generate').waitFor();
  const full = await context.newPage(); await full.goto(`${origin}/#/plugins/ui-flashcards`); await full.getByText('停用后仍保留的历史卡片', { exact: true }).waitFor();
  await change('flashcards', '停用插件');
  await page.getByTestId('board-plugin-flashcards').waitFor({ state: 'detached' });
  await page.getByTestId('board-plugin-cards-reader').waitFor({ state: 'detached' });
  await full.getByRole('alert').getByText('原数据保留', { exact: false }).waitFor({ timeout: 15000 });
  await reader.waitForFunction(() => document.querySelector('[data-testid="cards-generate"]')?.disabled);
  await reader.getByText('学习卡片插件不可用；历史卡片仍可阅读与导出', { exact: true }).waitFor();
  await reader.getByText('停用后仍保留的历史卡片', { exact: true }).waitFor();
  assert.equal(await reader.getByTestId('cards-export').isEnabled(), true);
  assert.equal(await reader.evaluate(async () => { try { await (await import('/src/pipelines/cards.ts')).runCards('unplug-video', () => {}); return 'bypass'; } catch (e) { return e.message; } }), 'plugin_unavailable');
  await reader.screenshot({ path: path.join(output, 'legacy-cards-disabled.png') });
  await change('flashcards', '卸载（保留数据）');
  await page.reload(); await openManager();
  assert.equal((await pluginTool(page, { operation: 'list' })).plugins.find(p => p.id === 'flashcards').installation, 'uninstalled');
  await page.screenshot({ path: path.join(output, 'uninstalled-page.png'), fullPage: true });
  await change('flashcards', '重新安装并恢复');
  await page.getByTestId('board-plugin-flashcards').getByText('停用后仍保留的历史卡片', { exact: true }).waitFor();
  await replacement.getByText('停用后仍保留的历史卡片', { exact: false }).waitFor();
  for (const id of ['practice', 'review', 'material-tools', 'cards-reader']) {
    await change(id, '停用插件'); await page.getByTestId(`board-plugin-${id}`).waitFor({ state: 'detached' });
     if (id === 'practice') { await page.getByTestId('board-plugin-review').waitFor({ state: 'detached' }); assert.ok((await pluginTool(page, { operation: 'list' })).plugins.find(p => p.id === 'review').error); }
    if (id === 'practice') {
      const result = await page.evaluate(async () => {
        let shown = false;
        const execute = (await import('/src/harness/tools.ts')).createToolExecutor('unplug-video', { onQuiz: () => { shown = true; } });
        try { await execute('present_quiz', { questions: [] }); return { error: 'bypass', shown }; } catch (e) { return { error: e.message, shown }; }
      }); assert.deepEqual(result, { error: 'plugin_unavailable', shown: false }, 'stale Chat tools cannot present a disabled quiz');
    }
    if (id === 'material-tools') {
      const rejected = await page.evaluate(async () => {
        const cases = [
          ['handout', async () => (await import('/src/pipelines/handout.ts')).runHandout('unplug-video', () => {})],
          ['comments', async () => (await import('/src/pipelines/comments.ts')).runComments('unplug-video', () => {})],
          ['danmaku', async () => (await import('/src/pipelines/danmaku.ts')).runDanmaku('unplug-video', () => {})],
          ['transcribe', async () => (await import('/src/pipelines/transcribe.ts')).runTranscription('unplug-video', () => {})],
          ['material', async () => (await import('/src/pipelines/materialJob.ts')).startMaterialJob('unplug-video', 'md')],
          ['cover', async () => (await import('/src/pipelines/cover.ts')).ensureCover('unplug-video')],
          ['handoutEdit', async () => (await import('/src/pipelines/handoutEdit.ts')).rewriteBlockWithLLM('原文', '改写', {})],
        ];
        return Promise.all(cases.map(async ([kind, run]) => { try { await run(); return [kind, 'bypass']; } catch (e) { return [kind, e.message]; } }));
      });
      for (const [kind, error] of rejected) assert.equal(error, 'plugin_unavailable', `disabled ${kind} raw pipeline`);
    }
    await change(id, '卸载（保留数据）'); await page.reload(); await openManager();
    await change(id, '重新安装并恢复'); await page.getByTestId(`board-plugin-${id}`).waitFor();
  }
  // The original four packages use the same real lifecycle tool.
  for (const id of ['tasks', 'todo', 'pomodoro', 'schedules']) {
    const host = page.getByTestId(`board-plugin-${id}`);
    await host.locator('iframe').waitFor();
    await change(id, '停用插件'); await host.waitFor({ state: 'detached' });
    await change(id, '卸载（保留数据）');
    await page.reload(); await openManager();
    assert.equal((await pluginTool(page, { operation: 'list' })).plugins.find(p => p.id === id).installation, 'uninstalled');
    await host.waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(output, `legacy-${id}-uninstalled.png`) });
    await change(id, '重新安装并恢复'); await host.locator('iframe').waitFor();
    assert.equal(files.catalog(owner).find(p => p.id === id).installation, 'enabled');
    assert.ok(JSON.parse(files.layout(owner).content).instances.some(instance => instance.id === `legacy-${id}`), 'original instance survives UI uninstall/reinstall');
  }
  // Server lifecycle remains authoritative after reload; browser flags cannot
  // substitute a local catalog or a worker execution permit.
  await openManager();
  await changePlugin(page, 'flashcards', '停用插件');
  assert.equal(await page.evaluate(async () => { try { await (await import('/src/pipelines/cards.ts')).runCards('unplug-video', () => {}); return 'bypass'; } catch (e) { return e.message; } }), 'plugin_unavailable');
  await changePlugin(page, 'flashcards', '卸载（保留数据）');
  await page.reload(); await openManager();
  assert.equal(await page.evaluate(async () => (await (await import('/src/client/plugin-renderer-commands.ts')).readRendererPluginCatalog()).plugins.find(p => p.id === 'flashcards').installation), 'uninstalled');
  await page.screenshot({ path: path.join(output, 'server-uninstalled.png'), fullPage: true });
  await changePlugin(page, 'flashcards', '重新安装并恢复');
  await changePlugin(page, 'flashcards', '停用插件');
  const workerResult = await page.evaluate(async () => {
    const { cloud } = await import('/src/cloud/state.ts'); const { assertPluginAvailable } = await import('/src/plugins/availability.ts');
    cloud.worker = true; cloud.acceptedPlugins = ['flashcards'];
    try { await assertPluginAvailable('flashcards'); return 'bypass'; } catch(e) { return e.message; }
    finally { delete cloud.worker; delete cloud.acceptedPlugins; }
  }); assert.equal(workerResult, 'plugin_unavailable', 'browser worker flags cannot bypass server plugin availability');
  const offlineResult = await page.evaluate(async () => {
    const { cloud } = await import('/src/cloud/state.ts'); const { assertPluginAvailable } = await import('/src/plugins/availability.ts');
    cloud.enabled = false;
    try { await assertPluginAvailable('flashcards'); return 'bypass'; } catch(e) { return e.message; }
    finally { cloud.enabled = true; }
  }); assert.equal(offlineResult, 'client_unauthenticated', 'disabled server mode cannot fall back to local plugins');
  await changePlugin(page, 'flashcards', '重新安装并恢复');
  await openManager();
   for (const width of [1440, 390, 360]) {
     await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
     await openManager();
    for (const theme of ['light', 'dark', 'auto']) {
      await page.emulateMedia({ colorScheme: theme === 'auto' ? 'dark' : theme });
      await page.evaluate(async theme => { (await import('/src/store/settings.ts')).useSettings.setState({ theme }); }, theme);
      await assertCreationHint(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `page ${width}/${theme} overflows`);
      await page.screenshot({ path: path.join(output, `create-mode-${width}-${theme}.png`), fullPage: true });
    }
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM cloud_tasks WHERE kind='cards'").get().n, 0, 'disabled card attempts created no task; automatic cover backfill is unrelated');
  console.log(`Pluggability browser passed: all eight default packages and sandbox alternative through server tools with reload/restoration, dependency removal, readonly history/export, raw pipeline and forged-worker/offline gates, 3 widths × 3 themes. Screenshots: ${output}`);
} catch (error) { if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); console.error(await page.locator('body').innerText()); } throw error; }
finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
