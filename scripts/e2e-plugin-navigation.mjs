import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { addPlugin, assertCreationHint, changePlugin, editLayout, pluginTool, openChatPlugins } from './plugin-tools.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/plugin-navigation-'));
const output = path.join(os.tmpdir(), 'opencode/create-mode-screenshots'); fs.mkdirSync(output, { recursive: true });
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
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
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'navigation-password-123' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const owner = (await (await post('/auth/password/login', { password: 'navigation-password-123' })).json()).user.id;
  const cookies = await context.cookies();
  const getLayout = async () => JSON.parse((await (await context.request.get(`${origin}/api/v1/plugins`)).json()).layout.content);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new PluginFiles(store);
  const configuration = new CloudConfiguration(store, path.dirname(process.env.BOOTSTRAP_SECRET_FILE));
  configuration.save(owner, { ...configuration.get(owner), policy: { ...configuration.get(owner).policy, read: 'allow', write: 'allow' } });
  page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('response', async response => { if (response.status() >= 500) console.error(response.url(), response.status(), await response.text()); });
  await page.goto(`${origin}/#/board`); await page.getByTestId('board-plugin-todo').waitFor(); await assertCreationHint(page);

  // Controlled model, production agent loop and resource executor, real persisted files.
  const runtime = fs.readFileSync('packages/study-core/assets/builtin/create-mode/references/runtime.md', 'utf8');
  const html = runtime.match(/```html\n([\s\S]*?)\n```/)[1];
  const manifest = { apiVersion: 2, id: 'created-counter', name: '我的计数器', version: '1.0.0', enabled: true, capabilities: ['state'], views: { main: { entry: 'views/main.html', surfaces: ['app.page', 'chat.sidepanel', 'chat.message'], height: 220 }, detail: { entry: 'views/detail.html', surfaces: ['app.page'], height: 180 } }, actions: { read: { title: '读取计数', service: 'state.read', schema: { type: 'object' } } } };
  const call = (name, args) => ({ name, args });
  const lastResult = body => JSON.parse(body.messages.filter(m => m.role === 'tool').at(-1).content);
  const sidebarLayout = doc => {
    const layout = JSON.parse(doc.content);
    layout.instances.push({ id: 'created-counter', pluginId: 'created-counter', title: '我的计数器', scope: { kind: 'account' } });
    layout.placements.push({ id: 'created-page', pluginId: 'created-counter', instanceId: 'created-counter', viewId: 'main', surface: 'app.page', scope: { kind: 'account' }, order: 10 });
    (layout.navigation ??= []).push({ id: 'created-nav', placementId: 'created-page', title: '我的计数器', order: 10 });
    return { operation: 'configure', content: JSON.stringify(layout), expected: doc.content, revision: doc.revision };
  };
  let steps = [], requests = [], initialLayout;
  await context.route('https://create.test/**', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    assert.ok(steps.length, 'no unscripted model calls');
    const next = await steps.shift()(body);
    const delta = typeof next === 'string' ? { role: 'assistant', content: next } : { role: 'assistant', tool_calls: (Array.isArray(next) ? next : [next]).map((item, index) => ({ index, id: `create-${requests.length}-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) };
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n` });
  });
  const run = text => page.evaluate(async text => {
    const { loadEnabledSkillMeta } = await import('/src/skills/store.ts');
    const skill = (await loadEnabledSkillMeta()).find(s => s.name === '创造模式');
    if (!skill) throw new Error('create skill missing');
    const { activateSkills } = await import('/src/skills/activation.ts');
    const activated = await activateSkills([skill.id], [skill.id]);
    const { createResourceExecutor, libraryResourceTools } = await import('/src/harness/resources.ts');
    const { runAgentLoop } = await import('/src/harness/agent.ts');
    return runAgentLoop([...activated.messages, { role: 'user', content: text }], libraryResourceTools(false), createResourceExecutor({ allowedSkillIds: [skill.id] }), { target: { baseUrl: 'https://create.test/v1', apiKey: 'fixture', model: 'fixture', protocol: 'openai-chat' } }, 6);
  }, text);
  steps = [
    () => [call('read', { path: '/skills/创造模式/references/references/tools-and-layout.md' }), call('read', { path: '/skills/创造模式/references/references/runtime.md' }), call('plugins', { operation: 'list' }), call('plugins', { operation: 'layout' })],
    body => {
      assert.match(JSON.stringify(body.messages), /UTF-16/); initialLayout = lastResult(body);
      return [call('edit', { path: '/system/plugins/created-counter/views/main.html', create: true, content: html }), call('edit', { path: '/system/plugins/created-counter/views/detail.html', create: true, content: '<h1>详细记录</h1>' }), call('edit', { path: '/system/plugins/created-counter/defaults.json', create: true, content: '{"count":0}' }), call('edit', { path: '/system/plugins/created-counter/manifest.json', create: true, content: JSON.stringify(manifest) })];
    },
    () => call('plugins', { operation: 'list' }),
    body => { assert.ok(lastResult(body).plugins.find(p => p.id === manifest.id && p.enabled && !p.error)); return call('plugins', sidebarLayout(initialLayout)); },
    () => call('plugins', { operation: 'list' }),
    body => { assert.ok(lastResult(body).layout.navigation.find(n => n.id === 'created-nav')); return '已创建：[我的计数器](#/plugins/created-counter?view=main&placement=created-page)。'; },
  ];
  const transcript = await run('做一个持久计数器，放在左侧侧边栏。');
  assert.equal(steps.length, 0); assert.match(transcript.at(-1).content, /created-page/);
  assert.match(JSON.stringify(requests[0].messages), /# 创造模式/);
  assert.ok(!JSON.stringify(requests[0].messages.filter(m => m.role === 'system')).includes('# 创造模式'), 'not a permanent system prompt');
  assert.equal(files.read(owner, '/system/plugins/created-counter/views/main.html').content, html);
  await page.getByTestId('nav-plugin-created-nav').click();
  const counter = page.frameLocator('iframe[title="我的计数器"]');
  await counter.getByRole('button', { name: '加一', exact: true }).click(); await counter.locator('output').getByText('1', { exact: true }).waitFor();
  await page.reload(); await counter.locator('output').getByText('1', { exact: true }).waitFor(); await assertCreationHint(page);
  await page.screenshot({ path: path.join(output, 'created-page-1440.png') });

  // Reuse the exact content through a second controlled-model/tool conversation.
  steps = [() => call('plugins', { operation: 'list' }), () => call('plugins', { operation: 'layout' }), body => {
    const doc = lastResult(body), layout = JSON.parse(doc.content);
    layout.placements.push({ id: 'created-chat', pluginId: 'created-counter', instanceId: 'created-counter', viewId: 'main', surface: 'chat.sidepanel', scope: { kind: 'account' }, order: 1 });
    return call('plugins', { operation: 'configure', content: JSON.stringify(layout), expected: doc.content, revision: doc.revision });
  }, () => call('plugins', { operation: 'list' }), body => { assert.ok(lastResult(body).layout.placements.find(p => p.id === 'created-chat')); return '已将同一份计数放到聊天侧栏，内容共用。'; }];
  await run('把刚才的计数器也放到聊天右侧，共用内容。'); assert.equal(steps.length, 0);
  const secondClient = await context.newPage(); await secondClient.goto(`${origin}/#/chat`);
  const composer = secondClient.locator('textarea[aria-label="给 AI 助手发送消息"]'); await composer.fill('保留我的草稿');
  const beforeSelection = await secondClient.evaluate(async () => { const s = (await import('/src/store/courseChat.ts')).useCourseChat.getState(); return { scope: s.skillIds, messages: s.messages.length }; });
  await secondClient.getByTestId('chat-add').click(); await secondClient.getByRole('menuitem', { name: /技能/ }).click();
  const picker = secondClient.getByTestId('skill-picker-dialog');
  await picker.locator('[data-skill-name="创造模式"] .skill-picker__name').click();
  assert.equal(await picker.getByRole('checkbox', { name: '创造模式', exact: true }).isChecked(), true);
  await secondClient.screenshot({ path: path.join(output, 'skill-selection-1440.png') });
  await secondClient.getByTestId('skill-picker-done').click(); await picker.waitFor({ state: 'detached' });
  assert.equal(await composer.inputValue(), '保留我的草稿');
  const afterSelection = await secondClient.evaluate(async () => { const s = (await import('/src/store/courseChat.ts')).useCourseChat.getState(); return { scope: s.skillIds, messages: s.messages.length, selected: s.turnSkillIds }; });
  assert.deepEqual(afterSelection.scope, beforeSelection.scope); assert.equal(afterSelection.messages, beforeSelection.messages);
  assert.equal(afterSelection.selected.length, 1);
  await openChatPlugins(secondClient);
  const chatCounter = secondClient.locator('[data-plugin-instance="created-counter"]').frameLocator('iframe');
  await chatCounter.locator('output').getByText('1', { exact: true }).waitFor();
  await chatCounter.getByRole('button', { name: '加一', exact: true }).click(); await counter.locator('output').getByText('2', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), '保留我的草稿');
  assert.equal((await getLayout()).instances.filter(i => i.pluginId === 'created-counter').length, 1);
  // Genuine CAS rejection then model re-read/remerge; unrelated title must survive.
  let stale;
  steps = [() => call('plugins', { operation: 'layout' }), async body => {
    stale = lastResult(body);
    await editLayout(secondClient, layout => { layout.navigation[0].title = '其他客户端的名字'; });
    const old = JSON.parse(stale.content); old.navigation[0].title = '不能覆盖';
    return call('plugins', { operation: 'configure', content: JSON.stringify(old), expected: stale.content, revision: stale.revision });
  }, body => { assert.match(body.messages.at(-1).content, /conflict|409/); return call('plugins', { operation: 'layout' }); }, body => {
    const doc = lastResult(body), layout = JSON.parse(doc.content); layout.navigation[0].order = 20;
    return call('plugins', { operation: 'configure', content: JSON.stringify(layout), expected: doc.content, revision: doc.revision });
  }, () => '已调整顺序，并保留另一客户端的新名称。'];
  await run('把计数器放到导航后面。'); assert.equal((await getLayout()).navigation[0].title, '其他客户端的名字');
  steps = [() => call('edit', { path: '/system/plugins/created-counter/manifest.json', create: true, content: '{}' }), body => {
    assert.match(body.messages.at(-1).content, /已有|存在|conflict|失败/);
    return '未完成：目标文件已存在，不能用创建操作覆盖；原功能保持不变。';
  }];
  const failedTurn = await run('测试失败不得报成功：不要覆盖已有 manifest。');
  assert.match(failedTurn.at(-1).content, /未完成/); assert.ok(!failedTurn.at(-1).content.includes('创建成功'));
  assert.equal(files.catalog(owner).find(p => p.id === 'created-counter').error, undefined);

  // Data/routing/lifecycle assertions remain; only the abandoned wizard checks changed.
  await addPlugin(page, { pluginId: 'todo', surface: 'app.page', instanceId: 'legacy-todo' });
  let layout = await getLayout(); const todoNav = layout.navigation.find(n => layout.placements.find(p => p.id === n.placementId)?.instanceId === 'legacy-todo');
  await page.getByTestId(`nav-plugin-${todoNav.id}`).click();
  const todo = page.frameLocator('iframe[title="待办"]');
  await todo.getByRole('textbox', { name: '待办内容' }).fill('共享的真实待办'); await todo.getByRole('button', { name: '添加', exact: true }).click(); await todo.getByText('共享的真实待办', { exact: true }).waitFor();
  await addPlugin(page, { pluginId: 'todo', surface: 'app.page', newContent: true, title: '独立待办' });
  layout = await getLayout(); const independent = layout.navigation.find(n => n.title === '独立待办');
   const independentInstance = layout.placements.find(p => p.id === independent.placementId).instanceId;
   assert.notEqual(independentInstance, 'legacy-todo');
   await page.getByTestId(`nav-plugin-${independent.id}`).click(); await todo.getByRole('textbox', { name: '待办内容' }).waitFor(); assert.equal(await todo.getByText('共享的真实待办', { exact: true }).count(), 0);
   const independentState = await pluginTool(page, { operation: 'describe', pluginId: 'todo' });
   const state = await page.evaluate(async ({ instanceId, revision }) => (await import('/src/api/serverClient.ts')).request(`/plugins/todo/instances/${instanceId}/rpc`, { method: 'POST', body: JSON.stringify({ revision, method: 'state.read', args: {} }) }), { instanceId: independentInstance, revision: independentState.plugin.revision });
   assert.deepEqual(JSON.parse(state.content).items, [], 'new content uses defaults, not the live shared state');
   await todo.getByRole('textbox', { name: '待办内容' }).fill('独立内容只留在这里'); await todo.getByRole('button', { name: '添加', exact: true }).click(); await todo.getByText('独立内容只留在这里', { exact: true }).waitFor();
  await editLayout(page, l => { l.navigation.find(n => n.id === todoNav.id).title = '每日计划'; l.navigation.find(n => n.id === todoNav.id).order = 100; });
  await page.getByTestId(`nav-plugin-${todoNav.id}`).getByText('每日计划', { exact: true }).waitFor();
  await editLayout(page, l => { l.navigation = l.navigation.filter(n => n.id !== todoNav.id); });
  await page.getByTestId(`nav-plugin-${todoNav.id}`).waitFor({ state: 'detached' });
  await page.goto(`${origin}/#/plugins/legacy-todo?view=default`); await todo.getByText('共享的真实待办', { exact: true }).waitFor();
  assert.equal(await todo.getByText('独立内容只留在这里', { exact: true }).count(), 0, 'switching back cannot leak another instance UI/state');
  await addPlugin(page, { pluginId: 'created-counter', surface: 'app.page', instanceId: 'created-counter', viewId: 'detail', title: '详细计数' });
  layout = await getLayout(); const detail = layout.navigation.find(n => n.title === '详细计数');
  await page.getByTestId(`nav-plugin-${detail.id}`).click(); await counter.getByRole('heading', { name: '详细记录' }).waitFor();
  await page.reload(); await counter.getByRole('heading', { name: '详细记录' }).waitFor();
  for (const action of ['停用插件', '卸载（保留数据）']) { await changePlugin(page, 'created-counter', action); await page.getByTestId('nav-plugin-created-nav').waitFor({ state: 'detached' }); await page.reload(); await assertCreationHint(page); }
  await changePlugin(page, 'created-counter', '重新安装并恢复'); await page.getByTestId('nav-plugin-created-nav').waitFor();
  await page.getByTestId('nav-plugin-created-nav').click(); await counter.locator('output').getByText('2', { exact: true }).waitFor();
  // Account switch clears prior navigation without a reload.
  const other = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, 'Other', new Date().toISOString());
  store.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), other, crypto.createHash('sha256').update(token).digest('hex'), new Date().toISOString(), new Date(Date.now() + 3600000).toISOString());
  await page.evaluate(async () => { await (await import('/src/api/serverClient.ts')).serverClient.session(); });
  await context.addCookies([{ name: 'wangke_session', value: token, url: origin }]);
  await page.evaluate(async () => { await (await import('/src/api/serverClient.ts')).serverClient.session(); });
  await page.getByTestId('nav-plugin-created-nav').waitFor({ state: 'detached' }); assert.equal((await getLayout()).navigation?.length ?? 0, 0);
  await context.addCookies(cookies); await page.evaluate(async () => { await (await import('/src/api/serverClient.ts')).serverClient.session(); });
  await page.getByTestId('nav-plugin-created-nav').waitFor();
  for (const width of [1440, 390, 360]) for (const theme of ['light', 'dark', 'auto']) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 }); await page.emulateMedia({ colorScheme: theme === 'auto' ? 'dark' : theme });
    await page.evaluate(async theme => { (await import('/src/store/settings.ts')).useSettings.setState({ theme }); }, theme);
    await assertCreationHint(page); await counter.locator('output').getByText('2', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `created-page-${width}-${theme}.png`) });
  }
  await page.getByRole('button', { name: /导航菜单|打开导航|导航/ }).first().click(); await page.getByTestId(`nav-plugin-${detail.id}`).click(); await counter.getByRole('heading', { name: '详细记录' }).waitFor();
  await page.locator('[role=dialog]').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(`Create mode/navigation passed: controlled-model + real Web tools create/reuse/CAS, persisted state/reload/two clients, independent defaults, rename/order/remove, precise multi-view routes, lifecycle, account switch, mobile drawer, no manual manager, draft intact, 3 widths × 3 themes. Screenshots: ${output}`);
} catch (error) { if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); console.error(await page.locator('body').innerText()); } throw error; }
finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
