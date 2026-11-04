import assert from 'node:assert/strict';
import { addPlugin, assertCreationHint } from './plugin-tools.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/plugin-project-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
const output = path.join(os.tmpdir(), 'opencode/plugin-platform-screenshots'); fs.mkdirSync(output, { recursive: true });
let web, browser;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite'), server: { watch: null, hmr: false, host: 'localhost', port: 0, proxy: { '/api': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false, ws: true } } } });
  await web.listen(); const origin = `http://localhost:${web.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'plugin-project-ui-password' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  await post('/auth/password/login', { password: 'plugin-project-ui-password' });
  const a = await (await post('/resources/folders', { name: '项目A' })).json();
  const b = await (await post('/resources/folders', { name: '项目B' })).json();
  const materials = [];
  for (const p of [a, b]) {
    await context.request.put(`${origin}/api/v1/projects/${p.id}/text?path=source.md`, { headers: { origin }, data: { text: '# 项目资料\n\n真实项目上下文', expectedRevision: null } });
    const listing = await (await context.request.get(`${origin}/api/v1/resources?projectId=${p.id}`)).json(); materials.push(listing.entries.find(e => e.courseId).courseId);
  }
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/#/board?project=${a.id}`);
  await page.getByLabel('项目上下文', { exact: true }).selectOption(a.id);
   await assertCreationHint(page);
   await addPlugin(page, { pluginId: 'todo', surface: 'board.main', newContent: true });
  const host = page.getByTestId('board-plugin-todo'); await page.locator('[data-testid="board-plugin-todo"]:not([data-plugin-instance="legacy-todo"])').waitFor(); const id = await host.getAttribute('data-plugin-instance'); assert.notEqual(id, 'legacy-todo');
  const frame = host.frameLocator('iframe'); await frame.getByRole('textbox', { name: '待办内容' }).fill('仅项目A共享'); await frame.getByRole('button', { name: '添加', exact: true }).click(); await frame.getByText('仅项目A共享', { exact: true }).waitFor();
   await addPlugin(page, { pluginId: 'todo', instanceId: id, surface: 'reader.sidepanel' }); await addPlugin(page, { pluginId: 'todo', instanceId: id, surface: 'chat.sidepanel' });
  const full = await context.newPage(); await full.goto(`${origin}/#/plugins/${id}`); await full.frameLocator('iframe[title="待办"]').getByText('仅项目A共享', { exact: true }).waitFor();
  const reader = await context.newPage(); await reader.goto(`${origin}/#/player/${materials[0]}`);
  await reader.getByTestId('panel-tab-plugins').waitFor({ state: 'attached' }); const toggle = reader.getByTestId('study-assistant-toggle'); if (await toggle.isVisible()) await toggle.click(); await reader.getByTestId('panel-tab-plugins').click();
  await reader.locator('[data-plugin-slot="reader.sidepanel"]').frameLocator('iframe').getByText('仅项目A共享', { exact: true }).waitFor();
  const catalog = await (await context.request.get(`${origin}/api/v1/plugins`)).json();
  const chat = await context.newPage(); await chat.goto(`${origin}/#/chat`); await chat.getByTestId('course-chat-page').waitFor();
  await chat.evaluate(async project => { const { useCourseChat } = await import('/src/store/courseChat.ts'); await useCourseChat.getState().setProject(project); }, { folderId: catalog.scopes.projectFolders.find(p => p.projectId === a.id).folderId, name: a.name });
  await chat.getByRole('button', { name: '组件', exact: true }).click();
  await chat.locator('[data-plugin-slot="chat.sidepanel"]').frameLocator('iframe').getByText('仅项目A共享', { exact: true }).waitFor();
  await chat.evaluate(async () => { const { useCourseChat } = await import('/src/store/courseChat.ts'); await useCourseChat.getState().setProject(null); });
  await chat.locator(`[data-plugin-instance="${id}"]`).waitFor({ state: 'detached' });
   await assertCreationHint(reader);
   await addPlugin(reader, { pluginId: 'todo', surface: 'reader.sidepanel', scope: `material:${materials[0]}`, newContent: true });
  const materialHost = reader.locator('[data-plugin-slot="reader.sidepanel"] [data-plugin-instance]').filter({ has: reader.locator('iframe') });
  await reader.locator(`[data-plugin-instance="${id}"]`).waitFor({ state: 'detached' });
  const mf = materialHost.frameLocator('iframe'); await mf.getByRole('textbox', { name: '待办内容' }).fill('仅资料A覆盖'); await mf.getByRole('button', { name: '添加', exact: true }).click(); await mf.getByText('仅资料A覆盖', { exact: true }).waitFor();
  await full.frameLocator('iframe[title="待办"]').getByText('仅项目A共享', { exact: true }).waitFor(); assert.equal(await full.frameLocator('iframe[title="待办"]').getByText('仅资料A覆盖', { exact: true }).count(), 0);
  const openReaderPlugins = async material => { await reader.goto(`${origin}/#/player/${material}`); await reader.getByTestId('panel-tab-plugins').waitFor({ state: 'attached' }); if (await toggle.isVisible()) await toggle.click(); await reader.getByTestId('panel-tab-plugins').click(); };
  await openReaderPlugins(materials[1]);
  assert.equal(await reader.locator(`[data-plugin-instance="${id}"]`).count(), 0);
  await openReaderPlugins(materials[0]); await mf.getByText('仅资料A覆盖', { exact: true }).waitFor();
  await page.getByLabel('项目上下文', { exact: true }).selectOption(b.id); await page.locator('[data-plugin-instance="legacy-todo"]').waitFor(); assert.equal(await page.locator(`[data-plugin-instance="${id}"]`).count(), 0);
   await addPlugin(page, { pluginId: 'todo', surface: 'board.main', newContent: true }); await page.locator('[data-testid="board-plugin-todo"]:not([data-plugin-instance="legacy-todo"])').waitFor(); const bid = await host.getAttribute('data-plugin-instance'); assert.notEqual(bid, id);
  await page.getByLabel('项目上下文', { exact: true }).selectOption(a.id); await frame.getByText('仅项目A共享', { exact: true }).waitFor();
  await page.reload(); await frame.getByText('仅项目A共享', { exact: true }).waitFor();
  for (const width of [1440, 390, 360]) for (const theme of ['light', 'dark', 'auto']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: theme === 'auto' ? 'dark' : theme });
    await page.evaluate(async theme => { const { useSettings } = await import('/src/store/settings.ts'); useSettings.setState({ theme }); }, theme);
    await frame.getByText('仅项目A共享', { exact: true }).waitFor();
     await assertCreationHint(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.screenshot({ path: path.join(output, `project-create-mode-${theme}-${width}.png`), fullPage: true });
    await full.setViewportSize({ width, height: 1000 });
    await full.emulateMedia({ colorScheme: theme === 'auto' ? 'dark' : theme });
    await full.evaluate(async theme => { const { useSettings } = await import('/src/store/settings.ts'); useSettings.setState({ theme }); }, theme);
    await full.waitForTimeout(500);
    await full.frameLocator('iframe[title="待办"]').getByText('仅项目A共享', { exact: true }).waitFor();
    await full.screenshot({ path: path.join(output, `project-shared-${theme}-${width}.png`) });
  }
  // Project/material pages keep their server-validated ownership when opened
  // from navigation, rather than inheriting an unrelated current project.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await addPlugin(page, { pluginId: 'todo', surface: 'app.page', instanceId: id });
  let saved = JSON.parse((await (await context.request.get(`${origin}/api/v1/plugins`)).json()).layout.content);
  const projectPin = saved.navigation.find(n => saved.placements.find(p => p.id === n.placementId)?.instanceId === id);
  await page.getByTestId(`nav-plugin-${projectPin.id}`).click();
  await page.getByText('仅用于 · 项目A', { exact: true }).waitFor();
  await page.frameLocator('iframe[title="待办"]').getByText('仅项目A共享', { exact: true }).waitFor();
  const materialInstance = await materialHost.getAttribute('data-plugin-instance');
  await addPlugin(reader, { pluginId: 'todo', surface: 'app.page', instanceId: materialInstance });
  const materialCatalog = await (await context.request.get(`${origin}/api/v1/plugins`)).json();
  saved = JSON.parse(materialCatalog.layout.content);
  const materialPin = saved.navigation.find(n => saved.placements.find(p => p.id === n.placementId)?.instanceId === materialInstance);
  assert.ok(materialPin);
  await full.setViewportSize({ width: 1440, height: 1000 });
  await full.getByTestId(`nav-plugin-${materialPin.id}`).click();
  const materialName = materialCatalog.scopes.materials.find(m => m.id === materials[0])?.name;
  assert.ok(materialName && materialName !== materials[0]);
  await full.getByText(`仅用于 · ${materialName}`, { exact: true }).waitFor();
  await full.frameLocator('iframe[title="待办"]').getByText('仅资料A覆盖', { exact: true }).waitFor();
  assert.equal((await context.request.patch(`${origin}/api/v1/projects/${a.id}`, { headers: { origin }, data: { archived: true } })).status(), 200);
  await page.getByTestId(`nav-plugin-${projectPin.id}`).waitFor({ state: 'detached' });
  await full.getByTestId(`nav-plugin-${materialPin.id}`).waitFor({ state: 'detached' });
  await full.getByRole('alert').getByText('原数据保留', { exact: false }).waitFor();
  assert.equal((await context.request.patch(`${origin}/api/v1/projects/${a.id}`, { headers: { origin }, data: { archived: false } })).status(), 200);
  await page.getByTestId(`nav-plugin-${projectPin.id}`).waitFor();
  await full.frameLocator('iframe[title="待办"]').getByText('仅资料A覆盖', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(`Project browser passed: real tool creation/reuse, project switching/isolation, reader/full-page sharing, refresh persistence and 3 sizes × 3 theme screenshots: ${output}`);
} catch (error) {
  if (browser) for (const [index, diagnosticPage] of browser.contexts().flatMap(c => c.pages()).entries()) {
    try { await diagnosticPage.screenshot({ path: path.join(output, `project-failure-${index}.png`) }); console.error(`${diagnosticPage.url()}\n${(await diagnosticPage.locator('body').innerText()).slice(0, 2000)}`); } catch { /* Closing tab. */ }
  }
  throw error;
} finally { await browser?.close(); await web?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
