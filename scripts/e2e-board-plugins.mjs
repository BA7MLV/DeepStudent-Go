import assert from 'node:assert/strict';
import { assertCreationHint, changePlugin } from './plugin-tools.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.join(os.tmpdir(), 'opencode'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'board-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://localhost:${port}`; process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let browser, store, web;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { watch: null, hmr: false, host: 'localhost', port, strictPort: true, proxy: { '/api/v1': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false } } } });
  await web.listen(); browser = await chromium.launch({ headless: true });
  // Playwright's SW-blocking probe itself throws in opaque sandboxed frames.
  const context = await browser.newContext({ locale: 'zh-CN' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'board-ui-password-123' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const login = await post('/auth/password/login', { password: 'board-ui-password-123' });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const at = new Date().toISOString();
  const insert = (id, status) => store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, id, 'material', 'course:fixture', '{}', status, at, at);
  insert('active', 'running'); insert('finished', 'completed');
  const thread = await post('/threads', { mode: 'bot', title: '定时测试会话' }); assert.equal(thread.status(), 201);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  await page.goto(`${origin}/#/tasks`);
  await page.getByTestId('board').waitFor({ timeout: 30000 });
  await page.evaluate(async () => { const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN'); });
  assert.ok(page.url().endsWith('#/board'), 'old task bookmarks redirect to board');
  const plugin = id => page.getByTestId(`board-plugin-${id}`).frameLocator('iframe');
  const task = plugin('tasks'), todo = plugin('todo'), timer = plugin('pomodoro'), schedules = plugin('schedules');
  await task.getByTestId('background-task-active').waitFor();
  assert.match(await task.getByTestId('background-task-active').innerText(), /由应用发起/);
  await task.getByRole('button', { name: /^最近记录/ }).click();
  await task.getByTestId('background-task-finished').waitFor();
  await task.getByRole('button', { name: /^进行中/ }).click();
  await task.getByRole('button', { name: '停止解析资料', exact: true }).click();
  await task.getByText('暂无进行中的后台任务', { exact: true }).waitFor();
  assert.equal(store.db.prepare("SELECT status FROM cloud_tasks WHERE id='active'").get().status, 'cancelled');

  await todo.getByRole('textbox', { name: '待办内容' }).fill('验证插件共享状态');
  await todo.getByRole('button', { name: '添加', exact: true }).click();
  await todo.getByText('验证插件共享状态', { exact: true }).waitFor();
  await todo.getByRole('checkbox').check();
  const getFile = async resource => (await context.request.get(`${origin}/api/v1/system/file?path=${encodeURIComponent(resource)}`)).json();
  const todoPath = '/system/board/plugins/todo/state.json';
  await page.waitForFunction(async url => { const d = await (await fetch(url)).json(); return JSON.parse(d.content).items[0]?.done === true; }, `${origin}/api/v1/system/file?path=${encodeURIComponent(todoPath)}`);
  const savedTodo = await getFile(todoPath);
  assert.equal((await post('/system/file', { path: todoPath, expected: savedTodo.content, revision: savedTodo.revision, content: JSON.stringify({ items: [{ id: 'from-bot', title: 'Bot 写入的新待办', done: false }] }) })).status(), 200);
  await todo.getByText('Bot 写入的新待办').waitFor({ timeout: 15000 });
  await timer.getByRole('button', { name: '开始专注', exact: true }).click();
  await timer.getByRole('button', { name: '暂停', exact: true }).waitFor();
  const timerBefore = JSON.parse((await getFile('/system/board/plugins/pomodoro/state.json')).content);
  await page.reload();
  await timer.getByRole('button', { name: '暂停', exact: true }).waitFor({ timeout: 30000 });
  const timerAfter = JSON.parse((await getFile('/system/board/plugins/pomodoro/state.json')).content);
  assert.equal(timerBefore.endsAt, timerAfter.endsAt, 'timer stores deadline, not a page-local counter');
  await schedules.getByLabel('交给 Bot 的任务').fill('请整理复习清单');
  await schedules.getByRole('button', { name: '创建定时任务', exact: true }).click();
  await schedules.getByText('请整理复习清单', { exact: true }).waitFor();
  const scheduleData = JSON.parse((await getFile('/system/board/plugins/schedules/schedules.json')).content);
  assert.equal(scheduleData.jobs.length, 1); assert.equal(scheduleData.jobs[0].threadId, (await thread.json()).id);
  await schedules.getByRole('button', { name: '停用', exact: true }).click();
  await schedules.getByRole('button', { name: '启用', exact: true }).waitFor();

  // An unknown id works without a frontend build or registration.
  for (const name of ['index.html', 'state.json', 'manifest.json']) {
    const template = await getFile(`/system/board/template/${name}`);
    const content = name === 'manifest.json' ? JSON.stringify({ ...JSON.parse(template.content), id: 'my-counter', name: '新计数插件', enabled: true }) : template.content;
    const result = await post('/system/file', { path: `/system/board/plugins/my-counter/${name}`, content, expected: '', revision: 0 });
    assert.equal(result.status(), 200, await result.text());
  }
  await plugin('my-counter').getByRole('button', { name: '+1', exact: true }).waitFor({ timeout: 15000 });
  await plugin('my-counter').getByRole('button', { name: '+1', exact: true }).click();
  await plugin('my-counter').getByText('1', { exact: true }).waitFor();
  // Sandboxed code cannot read host DOM/cookies or call another plugin's capabilities.
  const iframe = page.frames().find(f => f.name() === '' && f !== page.mainFrame() && f.url() === 'about:srcdoc');
  assert.ok(iframe);
  assert.equal(await iframe.evaluate(() => { try { void parent.document.body; return false; } catch { return true; } }), true);
  await todo.getByRole('textbox', { name: '待办内容' }).fill('未提交的草稿');
  await assertCreationHint(page);
  await changePlugin(page, 'my-counter', '停用插件');
  await page.getByTestId('board-plugin-my-counter').waitFor({ state: 'hidden' });
  assert.equal(await todo.getByRole('textbox', { name: '待办内容' }).inputValue(), '未提交的草稿', 'tool configuration preserves running frames and drafts');
  await page.reload();
  await page.getByTestId('board-plugin-todo').waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('board-plugin-my-counter').count(), 0);
  await changePlugin(page, 'my-counter', '启用插件');
  await plugin('my-counter').getByText('1', { exact: true }).waitFor();
  const output = process.env.SCREENSHOT_DIR ?? path.join(root, 'board-plugin-screenshots'); fs.mkdirSync(output, { recursive: true });
  const setTheme = theme => page.evaluate(async theme => { const { useSettings } = await import('/src/store/settings.ts'); useSettings.setState({ theme }); }, theme);
  const assertTheme = async scheme => {
    await page.waitForFunction(scheme => getComputedStyle(document.documentElement).colorScheme === scheme, scheme);
    const host = await page.getByTestId('board-plugin-todo').evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    for (const child of page.frames().filter(frame => frame.url() === 'about:srcdoc')) {
      await child.waitForFunction(scheme => getComputedStyle(document.documentElement).colorScheme === scheme, scheme);
      const colors = await child.evaluate(() => ({
        foreground: getComputedStyle(document.body).color,
        background: getComputedStyle(document.documentElement).backgroundColor,
        theme: document.documentElement.dataset.theme,
        dark: document.documentElement.classList.contains('dark'),
        controls: [...document.querySelectorAll('input,select,textarea,button')].map(element => getComputedStyle(element).colorScheme),
      }));
      assert.equal(colors.foreground, host.foreground, `${scheme}: plugin text follows the host`);
      assert.equal(colors.background, host.background, `${scheme}: iframe canvas matches the card, never an automatic white canvas`);
      assert.equal(colors.theme, scheme); assert.equal(colors.dark, scheme === 'dark');
      assert.ok(colors.controls.every(value => value === scheme), `${scheme}: native controls follow the app, not the OS preference`);
    }
  };
  const liveFrames = page.frames().filter(frame => frame.url() === 'about:srcdoc');
  for (const frame of liveFrames) await frame.evaluate(() => { window.themeDraftMarker = 'keep-frame-alive'; });
  await todo.getByRole('textbox', { name: '待办内容' }).fill('切换主题时保留的草稿');
  await page.emulateMedia({ colorScheme: 'light' });
  await setTheme('dark'); await assertTheme('dark');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width < 640 ? 844 : 1000 });
    await page.getByTestId('page-main').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(output, `board-dark-${width}.png`) });
  }
  await setTheme('auto'); await assertTheme('light');
  await page.emulateMedia({ colorScheme: 'dark' }); await assertTheme('dark');
  await setTheme('light'); await assertTheme('light');
  for (const frame of liveFrames) assert.equal(await frame.evaluate(() => window.themeDraftMarker), 'keep-frame-alive', 'theme switches never reload plugins');
  assert.equal(await todo.getByRole('textbox', { name: '待办内容' }).inputValue(), '切换主题时保留的草稿');
  await setTheme('dark');
  await page.reload();
  await timer.getByRole('button', { name: '暂停', exact: true }).waitFor();
  await plugin('my-counter').getByText('1', { exact: true }).waitFor();
  await assertTheme('dark');
  await assertCreationHint(page);
  await setTheme('light'); await assertTheme('light');
  await page.emulateMedia({ colorScheme: 'light' });
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width < 640 ? 844 : 1000 });
    await page.getByTestId('page-main').evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no page overflow at ${width}`);
    for (const child of page.frames().filter(f => f.url() === 'about:srcdoc')) assert.equal(await child.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no plugin overflow at ${width}`);
    if (width < 640) {
      assert.equal(await page.getByRole('link', { name: '插件模板', exact: true }).count(), 0, 'developer resources stay inside the manager');
      const first = await page.getByTestId('board-plugin-tasks').boundingBox();
      assert.ok(first.height < 190, `empty task card is compact at ${width}: ${first.height}`);
      const clock = await timer.locator('#clock').boundingBox();
      assert.ok(clock.y + clock.height < 844, `focus timer is visible on the first screen at ${width}`);
    }
    await page.screenshot({ path: path.join(output, `board-${width}.png`), fullPage: true });
    await assertCreationHint(page);
  }
  // Observe a durable Bot run through the real iframe SDK, including nonterminal waits.
  const { BotApplicationService } = await import('../apps/api/src/agent/service.ts');
  const bots = new BotApplicationService(store, { enqueue() {} });
  const threadId = (await thread.json()).id;
  const message = bots.send(owner, threadId, { clientNonce: 'callback-fixture', content: '整理新增资料并生成复习清单' });
  const runId = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
  store.db.prepare("UPDATE runs SET status='paused',step_count=3 WHERE id=?").run(runId);
  const taskId = `bot:${runId}`;
  const taskFrame = await (await page.getByTestId('board-plugin-tasks').locator('iframe').elementHandle()).contentFrame();
  await taskFrame.evaluate(id => {
    window.taskChanges = []; window.taskResult = null;
    board.tasks.watch(id, task => window.taskChanges.push(task.status), { onError: error => { throw error; } });
    board.tasks.wait(id).then(task => { window.taskResult = task; });
  }, taskId);
  await taskFrame.waitForFunction(() => window.taskChanges.includes('paused'));
  assert.equal(await taskFrame.evaluate(() => window.taskResult), null, 'paused is not completed');
  await task.getByRole('combobox', { name: '任务来源' }).selectOption('bot');
  const botRow = task.getByTestId(`background-task-${taskId}`);
  await botRow.getByText(/已暂停/).waitFor();
  store.db.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(runId);
  await taskFrame.waitForFunction(() => window.taskChanges.includes('waiting_user'));
  assert.equal(await taskFrame.evaluate(() => window.taskResult), null, 'waiting for the user is not completed');
  await botRow.getByText(/等待确认/).waitFor();
  assert.equal(await taskFrame.evaluate(async id => {
    const controller = new AbortController();
    const waiting = board.tasks.wait(id, { signal: controller.signal }); controller.abort();
    try { await waiting; return 'unexpected'; } catch (error) { return error.name; }
  }, taskId), 'AbortError');
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status, 'waiting_user', 'aborting a wait never cancels the task');
  bots.append(threadId, 'assistant', 'text', '已整理 3 份资料，复习清单已生成。', `bot:${runId}:reply:4`);
  store.db.prepare("UPDATE runs SET status='completed',completed_at=? WHERE id=?").run(new Date().toISOString(), runId);
  await taskFrame.waitForFunction(() => window.taskResult?.status === 'completed' && window.taskChanges.includes('completed'));
  assert.equal(await taskFrame.evaluate(() => window.taskChanges.filter(s => s === 'completed').length), 1, 'completion callback fires once per subscription');
  assert.equal(await taskFrame.evaluate(() => window.taskResult.result.text), '已整理 3 份资料，复习清单已生成。');
  await task.getByRole('button', { name: /^最近记录/ }).click();
  await botRow.getByText(/已完成/).waitFor();
  await botRow.getByText('查看结果', { exact: true }).click();
  await botRow.getByText('已整理 3 份资料，复习清单已生成。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('page-main').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'board-task-result-390.png') });
  await page.reload();
  await task.locator('#scope').waitFor();
  const restored = await task.locator('body').evaluate(async (_body, id) => board.tasks.wait(id), taskId);
  assert.equal(restored.result.text, '已整理 3 份资料，复习清单已生成。', 'reload can recover a completed result from its durable id');
  await task.getByRole('button', { name: /^最近记录/ }).click();
  await task.getByTestId(`background-task-${taskId}`).getByRole('button', { name: '查看会话', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/');
  await page.goto(`${origin}/#/board`);
  for (const file of ['manifest.json', 'index.html', 'state.json']) {
    assert.ok((await getFile(`/system/board/template/${file}`)).content.length > 0, 'templates remain readable by tools');
  }
  await page.goto(`${origin}/#/board`);
  await page.goto(`${origin}/#/player/${encodeURIComponent(`system:file:${encodeURIComponent('/system/board/plugins/todo/manifest.json')}`)}`);
  await page.waitForURL(url => decodeURIComponent(decodeURIComponent(url.hash)).includes('/system/board/plugins/todo/manifest.json'));
  await page.getByRole('heading', { name: 'manifest.json', exact: true }).waitFor();
  await page.goto(`${origin}/#/board`);
  await page.getByTestId('board').waitFor();
  await page.evaluate(async () => { const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('en-US'); });
  await todo.getByRole('button', { name: 'Add', exact: true }).waitFor();
  await task.getByRole('button', { name: /^Recent/ }).click();
  await task.getByText('Parse document', { exact: true }).first().waitFor();
  await page.goto(`${origin}/#/player/${encodeURIComponent(`system:file:${encodeURIComponent('/system/board/README.md')}`)}`);
  await page.getByText('看板插件 · API v1', { exact: true }).first().waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
  console.log(`Board UI passed: shared files, timer, schedules, hot-load, light/dark/auto theme sync and cold load without losing drafts, Create mode guidance, Bot task callbacks, conversation links, templates/docs, languages, 360/390/1440px. Screenshots: ${output}`);
} catch (error) {
  for (const page of browser?.contexts()[0]?.pages() ?? []) await page.screenshot({ path: path.join(root, 'board-ui-failure.png') }).catch(() => {});
  for (const page of browser?.contexts()[0]?.pages() ?? []) { console.error((await page.locator('body').innerText()).slice(-6000)); for (const frame of page.frames().slice(1)) console.error((await frame.locator('body').innerText()).slice(-2000)); }
  throw error;
} finally {
  await browser?.close(); await web?.close(); await app.close(); store?.close(); fs.rmSync(directory, { recursive: true, force: true });
}
