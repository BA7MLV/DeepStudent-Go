import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Readable } from 'node:stream';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.join(os.tmpdir(), 'opencode'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'plugin-platform-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://localhost:${port}`; process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const { CloudTaskRunner } = await import('../apps/api/src/cloud/tasks.ts');
const { receiveFile } = await import('../apps/api/src/cloud/files.ts');
const botFixtureFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  if (body.messages?.some(m => m.role === 'user' && String(m.content).includes('逐页提取这份资料的原题'))) {
    const turn = body.messages.slice(body.messages.findLastIndex(m => m.role === 'user') + 1);
    const results = turn.filter(m => m.role === 'tool');
    const call = (index, name, args) => ({ index, id: `extract-${name}-${index}-${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const edited = turn.some(m => m.tool_calls?.some(t => t.function.name === 'edit'));
    const delta = !results.length ? { role: 'assistant', tool_calls: [call(0, 'read', { path: '/skills/原题题库' }), call(1, 'read', { path: '/courses/current/questions.md' })] }
      : !edited ? { role: 'assistant', tool_calls: [call(0, 'edit', { path: '/courses/current/questions.md', edits: [{ old_string: '# 原题', new_string: '# 原题\n\n浏览器提取已保存部分；保留用户原有题目与笔记。' }] })] }
        : { role: 'assistant', content: '已保存题库中的一题，保留原内容。没有宣称覆盖全文。' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  return Response.json({ choices: [{ message: { role: 'assistant', content: '模板 Bot 任务已真实完成。' }, finish_reason: 'stop' }] });
};
let app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: botFixtureFetch });
let browser, web, store, learningRunner;
const output = process.env.SCREENSHOT_DIR ?? path.join(root, 'plugin-platform-screenshots'); fs.mkdirSync(output, { recursive: true });
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const apiPort = app.server.address().port;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { watch: null, hmr: false, host: 'localhost', port, strictPort: true, proxy: { '/api/v1': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } } });
  await web.listen(); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'plugins-ui-password-123' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const owner = (await (await post('/auth/password/login', { password: 'plugins-ui-password-123' })).json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new PluginFiles(store); files.layout(owner);
  const material = { id: 'plugin-source', name: '插件上下文验收资料', kind: 'material', materialFormat: 'md', mimeType: 'text/markdown', duration: 0, createdAt: Date.now(), status: 'transcribed' };
  new CloudRecords(store).apply(owner, [{ id: 'plugin-source', table: 'videos', key: material.id, before: null, after: material }]);
  new CloudRecords(store).apply(owner, [{ id: 'plugin-source-block', table: 'materialBlocks', key: 700, before: null, after: { id: 700, materialId: material.id, idx: 0, text: '这份已解析的真实资料用于验证卡片生成、复习审核与持久收据。' } }]);
  const bankId = `__course_questions__${encodeURIComponent(material.id)}`;
  const bankQuestion = { stem: '原题闭环验收：哪项是权威记录？', options: ['原错题本 Markdown', '组件临时状态', '随机示例', '页面回调'], answer: 0, explanation: '原错题本是唯一学习记录。', answerSource: 'original', source: { courseId: material.id, name: material.name, page: 1 } };
  const bankBytes = Buffer.from(`# 原题\n\n\`\`\`quiz\n${JSON.stringify({ questions: [bankQuestion] })}\n\`\`\`\n`);
  const bankFile = await receiveFile(store, path.join(directory, 'files'), owner, Readable.from([bankBytes]), 'questions.md', 'text/markdown', bankBytes.length, bankBytes.length);
  new CloudRecords(store).apply(owner, [{ id: 'bank-material', table: 'videos', key: bankId, before: null, after: { ...material, id: bankId, name: '原题题库.md' } }, { id: 'bank-file', table: 'files', key: bankId, before: null, after: { id: bankId, blob: { $file: bankFile.id } } }]);
  const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
  configuration.save(owner, { ...configuration.get(owner), policy: { ...configuration.get(owner).policy, read: 'allow', write: 'allow' }, providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-chat', apiKey: 'fixture', baseUrl: 'https://fixture.example/v1', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture-model' } });
   learningRunner = new CloudTaskRunner(store, { configuration, fetch: async (_url, init) => Response.json({ choices: [{ message: { content: String(init.body).includes('学习练习生成器') ? JSON.stringify({ questions: [{ ...bankQuestion, stem: 'AI 练习验收：如何确认产物保存？' }] }) : JSON.parse(init.body).max_tokens === 6000 ? '# 插件讲义验收\n\n讲义来自原资料执行器，并保存到原产物。' : '[{"time":"00:10","q":"如何确认插件生成成功？","a":"读取真实产物和持久完成收据。"}]' } }] }) });
  learningRunner.start(origin);
  const page = await context.newPage(), errors = [];
  context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/#/board`); await page.getByTestId('board-plugin-todo').waitFor({ timeout: 30000 });
  const manager = page.locator('.plugin-manager'); await manager.locator('summary').first().click();
  const choose = (label, value) => manager.getByLabel(label, { exact: true }).selectOption(value);
  const saveMount = () => Promise.all([page.waitForResponse(r => r.url().endsWith('/plugins/layout') && r.status() === 200), manager.getByRole('button', { name: '保存挂载', exact: true }).click()]);
  await choose('位置', 'chat.sidepanel'); await choose('插件', 'todo'); await choose('数据实例', 'legacy-todo');
  await saveMount();
  await choose('位置', 'reader.sidepanel'); await saveMount();
  await choose('位置', 'board.main'); await choose('数据实例', ''); await saveMount();
  await page.locator('[data-plugin-instance]').filter({ has: page.locator('iframe') }).nth(4).waitFor();
  const todos = page.getByTestId('board-plugin-todo'); assert.equal(await todos.count(), 2);
  const shared = page.locator('[data-plugin-instance="legacy-todo"]').frameLocator('iframe');
  await shared.getByRole('textbox', { name: '待办内容' }).fill('真实跨位置共享待办'); await shared.getByRole('button', { name: '添加', exact: true }).click();
  await shared.getByText('真实跨位置共享待办', { exact: true }).waitFor();
  const independent = todos.nth(1).frameLocator('iframe'); assert.equal(await independent.getByText('真实跨位置共享待办', { exact: true }).count(), 0);
  const chat = await context.newPage(); await chat.goto(`${origin}/#/chat`); await chat.getByTestId('course-chat-page').waitFor();
  await chat.getByRole('button', { name: '组件', exact: true }).click();
  const chatTodo = chat.locator('[data-plugin-slot="chat.sidepanel"] [data-plugin-instance="legacy-todo"]').frameLocator('iframe');
  await chatTodo.getByText('真实跨位置共享待办', { exact: true }).waitFor(); await chatTodo.getByRole('checkbox').check();
  await shared.getByRole('checkbox').waitFor(); await page.waitForTimeout(5500); assert.equal(await shared.getByRole('checkbox').isChecked(), true);
  const reader = await context.newPage(); await reader.goto(`${origin}/#/board`); await reader.getByTestId('board-plugin-todo').first().waitFor();
  await reader.evaluate(async material => { const { db } = await import('/src/store/db.ts'); await db.videos.put(material); await db.files.put({ id: material.id, blob: new Blob(['# 资料\n\n用于验证阅读侧栏的资料上下文。'], { type: 'text/markdown' }) }); }, material);
  await reader.goto(`${origin}/#/player/${material.id}`); await reader.getByTestId('panel-tab-plugins').waitFor({ state: 'attached' });
  const toggle = reader.getByTestId('study-assistant-toggle'); if (await toggle.isVisible()) await toggle.click();
  await reader.getByTestId('panel-tab-plugins').click();
  await reader.locator('[data-plugin-slot="reader.sidepanel"]').frameLocator('iframe').getByText('真实跨位置共享待办', { exact: true }).waitFor();
   const full = await context.newPage(); await full.goto(`${origin}/#/plugins/legacy-todo`);
   try { await full.frameLocator('iframe[title="待办"]').getByText('真实跨位置共享待办', { exact: true }).waitFor(); }
   catch (error) { await full.screenshot({ path: path.join(output, 'full-page-failure.png') }); throw new Error(`${error.message}\nFull page: ${await full.locator('body').innerText()}\nErrors: ${JSON.stringify(errors)}\nFrames: ${JSON.stringify(await full.locator('iframe').evaluateAll(elements => elements.map(e => ({ title: e.title, src: e.src }))))}`); }
  // The compile-time learning view uses the same manager and shared domain records.
  await choose('位置', 'board.main'); await choose('插件', 'flashcards'); await saveMount();
  const cardHost = page.getByTestId('board-plugin-flashcards'); await cardHost.waitFor();
  const cardsInstance = await cardHost.getAttribute('data-plugin-instance');
  await choose('数据实例', cardsInstance); await choose('位置', 'chat.sidepanel'); await saveMount();
  await choose('位置', 'reader.sidepanel'); await saveMount();
  await cardHost.getByLabel('卡片资料').selectOption(material.id);
  await cardHost.getByRole('button', { name: '生成卡片', exact: true }).click();
  await cardHost.getByText('如何确认插件生成成功？', { exact: true }).waitFor({ timeout: 30000 });
  await cardHost.getByText('已保存 1 张卡片', { exact: true }).waitFor();
  const chatCards = chat.getByTestId('board-plugin-flashcards'); await chatCards.waitFor();
  await chatCards.getByLabel('卡片资料').selectOption(material.id);
  await chatCards.getByText('如何确认插件生成成功？', { exact: true }).waitFor();
  await chatCards.getByRole('button', { name: '保留', exact: true }).click();
  await cardHost.getByText('1 张卡片 · 已保留 1 张', { exact: true }).waitFor();
  await reader.getByTestId('board-plugin-flashcards').getByText('1 张卡片 · 已保留 1 张', { exact: true }).waitFor();
  const cardsFull = await context.newPage(); await cardsFull.goto(`${origin}/#/plugins/${cardsInstance}`);
  await cardsFull.getByLabel('卡片资料').selectOption(material.id);
  await cardsFull.getByText('1 张卡片 · 已保留 1 张', { exact: true }).waitFor();
  await choose('位置', 'board.main'); await choose('插件', 'practice'); await saveMount();
  const practiceHost = page.getByTestId('board-plugin-practice'); await practiceHost.waitFor();
  const practiceInstance = await practiceHost.getAttribute('data-plugin-instance');
  await choose('数据实例', practiceInstance); await choose('位置', 'chat.sidepanel'); await saveMount();
  await choose('位置', 'reader.sidepanel'); await saveMount();
  const practiceFull = await context.newPage(); await practiceFull.goto(`${origin}/#/plugins/${practiceInstance}`);
  await practiceFull.getByLabel('练习资料').selectOption(material.id);
  await practiceFull.getByRole('button', { name: '生成 AI 练习', exact: true }).click();
  await practiceFull.getByText('AI 练习验收：如何确认产物保存？', { exact: true }).waitFor({ timeout: 30000 });
  await practiceFull.getByText('AI 参考答案，尚未核验', { exact: false }).waitFor();
  await practiceFull.locator('.quiz-option').nth(1).click();
  await practiceFull.getByTestId('quiz-explain').getByText('已作答；AI 参考答案：', { exact: false }).waitFor();
  await practiceFull.getByRole('button', { name: '打开原题题库', exact: true }).click();
  await practiceFull.getByText(bankQuestion.stem, { exact: true }).waitFor();
  await practiceFull.locator('.quiz-option').nth(1).click();
  await practiceFull.getByTestId('quiz-explain').getByText('正确答案：A', { exact: false }).waitFor();
  const practiceChat = chat.getByTestId('board-plugin-practice'); await practiceChat.getByLabel('练习资料').selectOption(material.id);
  await practiceChat.getByText(bankQuestion.stem, { exact: true }).waitFor();
  await practiceChat.getByTestId('quiz-explain').getByText('正确答案：A', { exact: false }).waitFor();
  await reader.getByTestId('board-plugin-practice').getByTestId('quiz-explain').getByText('正确答案：A', { exact: false }).waitFor();
  await choose('位置', 'board.main'); await choose('插件', 'review'); await saveMount();
  const reviewHost = page.getByTestId('board-plugin-review'); await reviewHost.waitFor();
  const reviewInstance = await reviewHost.getAttribute('data-plugin-instance');
   const reviewFull = await context.newPage(); await reviewFull.goto(`${origin}/#/plugins/${reviewInstance}`);
  await reviewFull.getByLabel('复习资料').selectOption(material.id);
  await reviewFull.getByText(bankQuestion.stem, { exact: true }).waitFor({ timeout: 30000 });
  await reviewFull.getByText('已作答 1 次', { exact: false }).waitFor();
  await reviewFull.getByRole('button', { name: '开始复习', exact: true }).click();
  await reviewFull.locator('.quiz-option').first().click();
  await reviewFull.getByTestId('quiz-explain').getByText('回答正确', { exact: true }).waitFor();
   await reviewFull.getByText('已作答 2 次', { exact: false }).waitFor();
   // All input controls still use the original QuizCard and host-side grading.
   // This separate source/instance cannot change the earlier course's attempts.
   const mixedMaterial = { ...material, id: 'plugin-mixed', name: '插件多题型原题.md' };
   const mixedPage = await context.newPage(); await mixedPage.goto(`${origin}/#/board`); await mixedPage.getByTestId('board-plugin-todo').first().waitFor();
   const imageMarkdown = await mixedPage.evaluate(() => {
     const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 180;
     const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f4f6fa'; ctx.fillRect(0, 0, 480, 180);
     ctx.strokeStyle = '#294675'; ctx.lineWidth = 3; ctx.strokeRect(24, 50, 140, 80); ctx.strokeRect(316, 50, 140, 80);
     ctx.beginPath(); ctx.moveTo(180, 90); ctx.lineTo(300, 90); ctx.lineTo(285, 80); ctx.moveTo(300, 90); ctx.lineTo(285, 100); ctx.stroke();
     ctx.fillStyle = '#172a48'; ctx.font = '24px sans-serif'; ctx.fillText('Source A', 38, 100); ctx.fillText('Result B', 330, 100);
     ctx.font = '18px sans-serif'; ctx.fillText('Original source diagram', 132, 30);
     return `![真实原图](${canvas.toDataURL('image/png')})`;
   });
   const imageHref = await mixedPage.evaluate(async ({ next, markdown }) => {
     const { listMaterialImages } = await import('/src/materials/images.ts'); const { materialImageHref } = await import('/src/materials/imageRefs.ts');
     const blob = new Blob([markdown], { type: 'text/markdown' });
     return materialImageHref(next.id, (await listMaterialImages(next, blob))[0].key);
   }, { next: mixedMaterial, markdown: imageMarkdown });
   const provenance = { answerSource: 'original', source: { courseId: mixedMaterial.id, name: mixedMaterial.name }, explanation: '原题参考解析。' };
   const mixedQuestions = [
     { ...provenance, type: 'multiple', stem: '多选与公式：$x^2$，选择甲和丙', options: ['甲', '乙', '丙'], answer: [0, 2], images: [imageHref] },
     { ...provenance, type: 'fill', stem: '填空：写出二', options: [], blanks: 1, answer: ['二'] },
     { ...provenance, type: 'boolean', stem: '判断：原图引用可以追溯', options: [], answer: true },
     { ...provenance, type: 'freeform', stem: '主观题：解释持久化', options: [], answer: '重启仍可读取', presentation: { html: '<label>自定义作答<textarea id="custom"></textarea></label><button type="button" onclick="void window.__wbw.setAnswerDraft(document.getElementById(\'custom\').value)">回传草稿</button>' } },
     { ...provenance, type: 'ordering', stem: '排序：先甲后乙', options: ['甲', '乙'], answer: [0, 1] },
     { ...provenance, type: 'matching', stem: '配对：甲一乙二', options: ['甲', '乙'], matches: ['一', '二'], answer: [0, 1] },
     { ...provenance, type: 'freeform', stem: '缺失答案不能自评为自动成绩', options: [], answer: -1, answerSource: 'missing' },
     { ...provenance, type: 'composite', stem: '组合题保留各小题作答', options: [], answer: [true, ['二']], parts: [
       { ...provenance, type: 'boolean', stem: '小题一：判断正确', options: [], answer: true },
       { ...provenance, type: 'fill', stem: '小题二：填二', options: [], blanks: 1, answer: ['二'] },
     ] },
   ];
   const mixedMarkdown = `${imageMarkdown}\n\n\`\`\`quiz\n${JSON.stringify({ questions: mixedQuestions })}\n\`\`\`\n`;
   const mixedBytes = Buffer.from(mixedMarkdown), mixedFile = await receiveFile(store, path.join(directory, 'files'), owner, Readable.from([mixedBytes]), 'mixed.md', 'text/markdown', mixedBytes.length, mixedBytes.length);
   new CloudRecords(store).apply(owner, [{ id: 'mixed-source', table: 'videos', key: mixedMaterial.id, before: null, after: mixedMaterial }, { id: 'mixed-file', table: 'files', key: mixedMaterial.id, before: null, after: { id: mixedMaterial.id, blob: { $file: mixedFile.id } } }]);
   await mixedPage.evaluate(async () => { const { flushCloud } = await import('/src/cloud/sync.ts'); await flushCloud(); });
   const mixedBefore = files.layout(owner), mixedLayout = JSON.parse(mixedBefore.content);
   mixedLayout.instances.push({ id: 'mixed-practice', pluginId: 'practice', scope: { kind: 'material', id: mixedMaterial.id } });
   files.save(owner, mixedBefore.path, JSON.stringify(mixedLayout), mixedBefore.content, mixedBefore.revision);
   await mixedPage.goto(`${origin}/#/plugins/mixed-practice`);
   await mixedPage.getByRole('button', { name: '打开原题题库', exact: true }).click();
   const mixedQ = index => mixedPage.locator(`[data-question-index="${index}"]`);
   await mixedQ(0).locator('.katex').first().waitFor();
   await mixedQ(0).locator('img').waitFor();
   assert.equal(await mixedQ(0).locator('img').evaluate(async image => { await image.decode(); return image.naturalWidth > 0; }), true, 'actual source image decodes');
   await mixedQ(0).locator('.quiz-option').nth(0).click(); await mixedQ(0).locator('.quiz-option').nth(2).click();
   await mixedQ(0).getByRole('button', { name: '提交答案', exact: true }).click(); await mixedQ(0).getByText('回答正确', { exact: true }).waitFor();
   await mixedQ(1).locator('input').fill('二'); await mixedPage.reload();
   await mixedQ(1).locator('input').waitFor(); assert.equal(await mixedQ(1).locator('input').inputValue(), '二', 'unsent standard input draft restores after refresh');
   assert.equal(await mixedQ(1).getByText('回答正确', { exact: true }).count(), 0, 'draft restoration is not a learning submission');
   await mixedQ(1).getByRole('button', { name: '提交答案', exact: true }).click(); await mixedQ(1).getByText('回答正确', { exact: true }).waitFor();
   await mixedQ(2).locator('.quiz-option').first().click(); await mixedQ(2).getByRole('button', { name: '提交答案', exact: true }).click(); await mixedQ(2).getByText('回答正确', { exact: true }).waitFor();
   const customInput = mixedQ(3).frameLocator('iframe');
   await customInput.getByLabel('自定义作答').fill('关闭页面和服务重启后仍可读取');
   assert.equal(await customInput.locator('body').evaluate(() => JSON.stringify(window.__wbw.answerInput).includes('重启仍可读取')), false, 'custom input iframe receives no reference answer');
   await customInput.getByRole('button', { name: '回传草稿', exact: true }).click();
   await mixedQ(3).getByLabel('交互作答草稿').getByText('关闭页面和服务重启后仍可读取', { exact: false }).waitFor();
   await mixedPage.reload();
   await mixedQ(3).getByLabel('交互作答草稿').getByText('关闭页面和服务重启后仍可读取', { exact: false }).waitFor();
   await mixedQ(3).getByRole('button', { name: '提交答案', exact: true }).click(); await mixedQ(3).getByText('已作答，请对照参考答案核对', { exact: true }).waitFor();
   await mixedQ(3).getByRole('button', { name: '我已核对：需复习', exact: true }).click(); await mixedQ(3).getByText('自评：需复习（非自动判分）', { exact: true }).waitFor();
   await mixedQ(4).getByRole('button', { name: '提交答案', exact: true }).click(); await mixedQ(4).getByText('回答正确', { exact: true }).waitFor();
   const mixedFirstRow = await mixedPage.getByLabel('练习记录').inputValue();
   await mixedPage.getByRole('button', { name: '下一批原题', exact: true }).click();
   await mixedQ(0).getByLabel('作答 · 配对 A').selectOption('0'); await mixedQ(0).getByLabel('作答 · 配对 B').selectOption('1');
   await mixedQ(0).getByRole('button', { name: '提交答案', exact: true }).click(); await mixedQ(0).getByText('回答正确', { exact: true }).waitFor();
   await mixedQ(1).getByLabel('作答', { exact: true }).fill('等待核验'); await mixedQ(1).getByRole('button', { name: '提交答案', exact: true }).click();
   await mixedQ(1).getByText('已作答，待补充答案后批改', { exact: true }).waitFor();
   assert.equal(await mixedQ(1).getByRole('button', { name: '我已核对：答对了', exact: true }).count(), 0);
   await mixedQ(2).locator('.quiz-part').first().locator('.quiz-option').first().click();
   await mixedQ(2).locator('.quiz-part').nth(1).locator('input').fill('二');
   await mixedQ(2).getByRole('button', { name: '提交答案', exact: true }).click(); await mixedQ(2).getByText('回答正确', { exact: true }).waitFor();
   await mixedPage.reload(); await mixedPage.getByLabel('练习记录').selectOption(mixedFirstRow);
   await mixedQ(3).getByText('自评：需复习（非自动判分）', { exact: true }).waitFor();
   await mixedQ(0).locator('.katex').first().waitFor();
   await mixedQ(3).getByRole('button', { name: '使用标准作答界面', exact: true }).click();
   assert.equal(await mixedQ(3).getByLabel('作答', { exact: true }).inputValue(), '关闭页面和服务重启后仍可读取');
   await mixedPage.setViewportSize({ width: 360, height: 844 });
   assert.equal(await mixedPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mixed inputs at 360px do not overflow');
    await mixedQ(0).scrollIntoViewIfNeeded();
    await mixedPage.screenshot({ path: path.join(output, 'learning-mixed-360.png') });
   await mixedQ(3).scrollIntoViewIfNeeded(); await mixedPage.screenshot({ path: path.join(output, 'learning-custom-360.png') }); await mixedPage.close();
  // Native declaration-driven controls use the same instance without navigation.
  await choose('插件', 'flashcards'); await choose('数据实例', cardsInstance);
  await choose('位置', 'chat.composer.actions'); await saveMount();
  const composerDraft = chat.locator('.course-chat__input'); await composerDraft.fill('打开组件不能丢失的草稿');
  await chat.locator('[data-plugin-actions="chat.composer.actions"]').getByRole('button', { name: '打开学习卡片', exact: true }).click();
  await chat.getByRole('dialog', { name: '打开学习卡片', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await composerDraft.inputValue(), '打开组件不能丢失的草稿');
  await choose('位置', 'reader.selection.actions'); await saveMount();
  await reader.evaluate(async () => {
    const { useSelectionAsk } = await import('/src/store/selectionAsk.ts');
    useSelectionAsk.getState().showBar({ text: '选区固定原资料，不会混写', source: 'md', unit: 1 }, { x: 180, y: 180 }, {});
  });
  await reader.getByTestId('selection-menu').locator('[data-plugin-actions="reader.selection.actions"]').getByRole('button', { name: '打开学习卡片', exact: true }).click();
  const selectionDialog = reader.getByRole('dialog', { name: '打开学习卡片', exact: true });
  await selectionDialog.getByText('如何确认插件生成成功？', { exact: true }).waitFor();
  await selectionDialog.getByRole('button', { name: '关闭', exact: true }).click();
  // Install a shipped HTML template, then read its shared state from a separate
  // browser context (independent storage/session cache, same authenticated owner).
  const templateRoot = path.resolve('docs/plugins/templates/counter');
  for (const relative of ['views/main.html', 'defaults.json', 'manifest.json']) files.save(owner, `/system/plugins/counter/${relative}`, fs.readFileSync(path.join(templateRoot, relative), 'utf8'), '', 0);
  const beforeTemplate = files.layout(owner), templateLayout = JSON.parse(beforeTemplate.content);
  templateLayout.instances.push({ id: 'template-counter', pluginId: 'counter', scope: { kind: 'account' } });
  files.save(owner, beforeTemplate.path, JSON.stringify(templateLayout), beforeTemplate.content, beforeTemplate.revision);
  const templatePage = await context.newPage(); await templatePage.goto(`${origin}/#/plugins/template-counter`);
    const counterFrame = templatePage.frameLocator('iframe[title="共享计数器模板"]');
    await counterFrame.locator('main[data-mounted="true"]').waitFor();
   await counterFrame.getByRole('button', { name: '加一', exact: true }).click();
  const secondDevice = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 } });
  const secondPage = await secondDevice.newPage(); await secondPage.goto(`${origin}/#/plugins/template-counter`);
   await secondPage.frameLocator('iframe[title="共享计数器模板"]').locator('#count').getByText('1', { exact: true }).waitFor();
   await secondPage.frameLocator('iframe[title="共享计数器模板"]').getByRole('button', { name: '加一', exact: true }).click();
   await counterFrame.locator('#count').getByText('2', { exact: true }).waitFor();
   await secondDevice.setOffline(true);
   await counterFrame.getByRole('button', { name: '加一', exact: true }).click();
   await counterFrame.locator('#count').getByText('3', { exact: true }).waitFor();
   await secondDevice.setOffline(false);
   await secondPage.frameLocator('iframe[title="共享计数器模板"]').locator('#count').getByText('3', { exact: true }).waitFor({ timeout: 20000 });
   // A persisted real Chat message stays readable when its pinned package changes.
   const referenceResponse = await post('/plugins/tool', { operation: 'reference', pluginId: 'counter', instanceId: 'template-counter', viewId: 'main', summary: '历史共享计数结果：已确认保存。' });
   assert.equal(referenceResponse.status(), 200);
   const reference = await referenceResponse.json();
   const messagePage = await context.newPage(); await messagePage.goto(`${origin}/#/chat`);
   await messagePage.getByTestId('course-chat-page').waitFor();
   await messagePage.evaluate(async markdown => {
     const { db } = await import('/src/store/db.ts');
     const { LIBRARY_ASSISTANT_ID } = await import('/src/harness/libraryAssistant.ts');
     const { useCourseChat } = await import('/src/store/courseChat.ts');
     const sessionId = await db.chatSessions.add({ videoId: LIBRARY_ASSISTANT_ID, title: '插件历史引用验收', createdAt: Date.now() });
     await db.chats.add({ videoId: LIBRARY_ASSISTANT_ID, sessionId, role: 'assistant', content: markdown, createdAt: Date.now() });
     await useCourseChat.getState().loadSession(sessionId);
    }, `${reference.markdown}\n\n${Array.from({ length: 100 }, (_, i) => `历史资料段落 ${i + 1}：验证长聊天的离屏插件只保留摘要，不运行 iframe。`).join('\n\n')}`);
   const messageHost = messagePage.locator('[data-plugin-reference="template-counter"]');
   await messageHost.getByText('历史共享计数结果：已确认保存。', { exact: true }).waitFor();
   assert.equal(await messageHost.locator('iframe').count(), 0, 'references do not auto-run package code');
   await messageHost.getByRole('button', { name: '展开插件视图', exact: true }).click();
    await messageHost.frameLocator('iframe').locator('#count').getByText('3', { exact: true }).waitFor();
    await messagePage.getByTestId('course-chat-messages').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await messageHost.locator('iframe').waitFor({ state: 'detached' });
    await messageHost.getByRole('button', { name: '收起插件视图', exact: true }).scrollIntoViewIfNeeded();
    await messageHost.frameLocator('iframe').locator('#count').getByText('3', { exact: true }).waitFor();
   await messageHost.getByRole('button', { name: '收起插件视图', exact: true }).click();
   assert.equal(await messageHost.locator('iframe').count(), 0);
   const counterManifest = files.read(owner, '/system/plugins/counter/manifest.json');
   files.save(owner, counterManifest.path, JSON.stringify({ ...JSON.parse(counterManifest.content), version: '1.0.1' }), counterManifest.content, counterManifest.revision);
   await messageHost.getByText('插件已停用、卸载、更新或实例不可用；历史摘要保留。', { exact: true }).waitFor({ timeout: 20000 });
   await messageHost.getByText('历史共享计数结果：已确认保存。', { exact: true }).waitFor();
   await messagePage.close();
   // The two other shipped templates run unchanged through the same host.
   for (const id of ['material-note', 'bot-task']) for (const relative of ['views/main.html', 'defaults.json', 'manifest.json']) files.save(owner, `/system/plugins/${id}/${relative}`, fs.readFileSync(path.resolve('docs/plugins/templates', id, relative), 'utf8'), '', 0);
   const templatesBefore = files.layout(owner), templatesLayout = JSON.parse(templatesBefore.content);
   templatesLayout.instances.push({ id: 'template-note', pluginId: 'material-note', scope: { kind: 'account' } }, { id: 'template-bot', pluginId: 'bot-task', scope: { kind: 'account' } });
   templatesLayout.placements.push({ id: 'template-note-reader', pluginId: 'material-note', instanceId: 'template-note', viewId: 'main', surface: 'reader.sidepanel', scope: { kind: 'account' }, order: 50 });
   files.save(owner, templatesBefore.path, JSON.stringify(templatesLayout), templatesBefore.content, templatesBefore.revision);
    const openReaderPlugins = async () => {
      try {
        const trigger = reader.getByTestId('study-assistant-toggle'); await trigger.waitFor({ state: 'attached' });
        if (await trigger.isVisible()) await trigger.click();
        await reader.getByTestId('panel-tab-plugins').click();
      } catch (error) {
        await reader.screenshot({ path: path.join(output, 'reader-open-failure.png') });
        throw new Error(`${error.message}\nReader URL: ${reader.url()}\nReader: ${await reader.locator('body').innerText()}\nErrors: ${JSON.stringify(errors)}`);
      }
   };
   await reader.reload();
   await openReaderPlugins();
   const noteFrame = reader.locator('[data-plugin-instance="template-note"]').frameLocator('iframe');
   await noteFrame.getByLabel('本资料笔记').fill('资料 A 的真实模板笔记');
    await noteFrame.getByRole('button', { name: '保存到共享实例', exact: true }).click();
    await noteFrame.getByText('已保存', { exact: true }).waitFor();
    const savedNote = await post('/plugins/material-note/instances/template-note/rpc', { method: 'state.read', args: {}, revision: files.catalog(owner).find(p => p.id === 'material-note').revision });
    assert.equal(JSON.parse((await savedNote.json()).content).notes[material.id], '资料 A 的真实模板笔记', 'save commits the typed draft before reload');
   await reader.reload(); await openReaderPlugins();
    await noteFrame.locator('#note:not([disabled])').waitFor();
    assert.equal(await noteFrame.getByLabel('本资料笔记').inputValue(), '资料 A 的真实模板笔记');
    await noteFrame.getByLabel('本资料笔记').fill('资料 A 的尺寸变化草稿');
    await reader.setViewportSize({ width: 1200, height: 1000 });
    await noteFrame.getByRole('button', { name: '保存到共享实例', exact: true }).click();
    await noteFrame.getByText('已保存', { exact: true }).waitFor();
    const materialB = { ...material, id: 'plugin-source-b', name: '插件上下文资料 B' };
    new CloudRecords(store).apply(owner, [{ id: 'plugin-source-b', table: 'videos', key: materialB.id, before: null, after: materialB }]);
    await reader.evaluate(async next => { const { db } = await import('/src/store/db.ts'); await db.videos.put(next); await db.files.put({ id: next.id, blob: new Blob(['# 资料 B'], { type: 'text/markdown' }) }); }, materialB);
    await reader.goto(`${origin}/#/player/${materialB.id}`); await openReaderPlugins();
    await noteFrame.locator('#note:not([disabled])').waitFor();
    assert.equal(await noteFrame.getByLabel('本资料笔记').inputValue(), '', 'A draft is never relabelled as B');
    await noteFrame.getByLabel('本资料笔记').fill('资料 B 的独立笔记');
    await noteFrame.getByRole('button', { name: '保存到共享实例', exact: true }).click();
    await noteFrame.getByText('已保存', { exact: true }).waitFor();
    await reader.goto(`${origin}/#/player/${material.id}`); await openReaderPlugins();
    await noteFrame.locator('#note:not([disabled])').waitFor();
    assert.equal(await noteFrame.getByLabel('本资料笔记').inputValue(), '资料 A 的尺寸变化草稿');
    // Old reader menus now launch the registered view in place, preserving drafts.
    await reader.getByTestId('panel-tab-chat').click();
    const oldComposer = reader.getByTestId('chat-input').locator('textarea');
    await oldComposer.fill('旧问答菜单打开插件后仍保留的草稿');
    await reader.getByTestId('panel-chat-add').click();
    await reader.getByTestId('question-bank-practice').click();
    const oldPracticeDialog = reader.getByRole('dialog', { name: '练习', exact: true });
    try { await oldPracticeDialog.getByRole('button', { name: '打开原题题库', exact: true }).click(); }
    catch (error) { await reader.screenshot({ path: path.join(output, 'legacy-menu-failure.png'), fullPage: true }); throw new Error(`${error.message}\nReader: ${await reader.locator('body').innerText()}`); }
    await oldPracticeDialog.getByText(bankQuestion.stem, { exact: true }).waitFor();
    await oldPracticeDialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await oldComposer.inputValue(), '旧问答菜单打开插件后仍保留的草稿');
    await reader.getByTestId('panel-chat-add').click();
    await reader.getByTestId('question-bank-review').click();
    const oldReviewDialog = reader.getByRole('dialog', { name: '复习清单', exact: true });
     await oldReviewDialog.getByText(bankQuestion.stem, { exact: true }).waitFor();
     await oldReviewDialog.getByRole('button', { name: '关闭', exact: true }).click();
     await reader.getByTestId('panel-chat-add').click();
     await reader.getByTestId('question-bank-extract').click();
     await oldPracticeDialog.getByRole('button', { name: '提取原题为题库', exact: true }).click();
     try { await oldPracticeDialog.getByText('题库现有 1 道原题', { exact: false }).waitFor({ timeout: 60000 }); }
     catch (error) {
       await reader.screenshot({ path: path.join(output, 'extraction-failure.png') });
       throw new Error(`${error.message}\nExtraction tasks: ${JSON.stringify(store.db.prepare("SELECT t.status,t.error,t.progress,t.result,l.error AS delivery_error FROM cloud_tasks t JOIN plugin_learning_tasks l ON l.task_id=t.id WHERE l.action_id='practice.extract'").all())}\nPermissions: ${JSON.stringify(store.db.prepare("SELECT capability,status,arguments FROM cloud_permissions WHERE task_id IN (SELECT task_id FROM plugin_learning_tasks WHERE action_id='practice.extract')").all())}\nDialog: ${await oldPracticeDialog.innerText()}`);
     }
     const extraction = store.db.prepare("SELECT t.*,l.result AS artifacts FROM cloud_tasks t JOIN plugin_learning_tasks l ON l.task_id=t.id WHERE l.owner_id=? AND l.action_id='practice.extract'").get(owner);
     assert.equal(extraction.executor, 'browser'); assert.equal(extraction.status, 'completed');
     assert.equal(JSON.parse(extraction.artifacts).kind, 'question-bank');
     const savedBank = new CloudRecords(store).get(owner, 'files', bankId);
     const savedBlob = store.db.prepare('SELECT storage_name FROM files WHERE id=? AND owner_id=?').get(savedBank.blob.$file, owner);
     const savedText = fs.readFileSync(path.join(directory, 'files', savedBlob.storage_name), 'utf8');
     assert.ok(savedText.includes('浏览器提取已保存部分')); assert.ok(savedText.includes(bankQuestion.stem), 'original QA edit preserves the original bank');
     // Keyboard stays in the modal, Escape returns to the intact reader draft.
     await oldPracticeDialog.getByRole('button', { name: '关闭', exact: true }).focus();
     for (let i = 0; i < 6; i++) {
       await reader.keyboard.press('Tab');
       assert.equal(await oldPracticeDialog.evaluate(element => element.contains(document.activeElement)), true, 'modal contains keyboard focus');
     }
     await reader.keyboard.press('Escape'); await oldPracticeDialog.waitFor({ state: 'hidden' });
     assert.equal(await oldComposer.inputValue(), '旧问答菜单打开插件后仍保留的草稿');
     await reader.getByTestId('panel-tab-plugins').click();
   const threadResponse = await post('/threads', { title: '模板 Bot 浏览器验收', mode: 'bot' });
   assert.equal(threadResponse.status(), 201); const thread = await threadResponse.json();
   const botPage = await context.newPage(); await botPage.goto(`${origin}/#/plugins/template-bot`);
   const botFrame = botPage.frameLocator('iframe[title="持久 Bot 任务模板"]');
   await botFrame.getByLabel('Bot 会话').selectOption(thread.id);
   await botFrame.getByLabel('任务', { exact: true }).fill('返回模板任务完成证据。');
   await botFrame.getByRole('button', { name: '启动任务', exact: true }).click();
   await botFrame.getByText('模板 Bot 任务已真实完成。', { exact: true }).waitFor({ timeout: 30000 });
   const runsBeforeReload = store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE thread_id=?').get(thread.id).n;
    await botPage.reload();
    try { await botFrame.getByText('模板 Bot 任务已真实完成。', { exact: true }).waitFor(); }
    catch (error) {
      await botPage.screenshot({ path: path.join(output, 'bot-restore-failure.png') });
      throw new Error(`${error.message}\nBot page: ${await botPage.locator('body').innerText()}\nBot frame: ${await botFrame.locator('body').innerText().catch(() => 'missing')}\nState: ${JSON.stringify(files.readState(owner, 'bot-task', 'template-bot', 'state'))}\nRuns: ${JSON.stringify(store.db.prepare('SELECT id,status,error_code FROM runs WHERE thread_id=?').all(thread.id))}\nErrors: ${JSON.stringify(errors)}`);
    }
   assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE thread_id=?').get(thread.id).n, runsBeforeReload, 'persisted template nonce recovers without another Bot run');
   await botPage.close();
   await choose('插件', 'flashcards'); await choose('数据实例', cardsInstance); await choose('位置', 'resource.actions'); await saveMount();
   const folderResponse = await post('/resources/folders', { name: '插件资源贡献验收' });
   assert.equal(folderResponse.status(), 201); const resourceFolder = await folderResponse.json();
   const textResponse = await context.request.put(`${origin}/api/v1/projects/${resourceFolder.id}/text?path=${encodeURIComponent('资源动作.md')}`, { headers: { origin }, data: { text: '# 资源贡献\n\n资料菜单保持原资料上下文。', expectedRevision: null } });
   assert.ok(textResponse.status() < 300, await textResponse.text());
   const resourcePage = await context.newPage(); await resourcePage.goto(`${origin}/#/library?folder=${resourceFolder.id}`);
   const resourceEntry = resourcePage.getByTestId('resource-entry').filter({ hasText: '资源动作.md' });
   await resourceEntry.locator('[data-plugin-actions="resource.actions"]').getByRole('button', { name: '打开学习卡片', exact: true }).click();
   const resourceDialog = resourcePage.getByRole('dialog', { name: '打开学习卡片', exact: true });
    await resourceDialog.getByTestId('plugin-flashcards').getByText('资源动作', { exact: true }).waitFor();
   await resourceDialog.getByRole('button', { name: '关闭', exact: true }).click();
   await resourceEntry.waitFor(); await resourcePage.close();
   await choose('位置', 'board.main'); await choose('插件', 'material-tools'); await saveMount();
   const toolsHost = page.getByTestId('board-plugin-material-tools');
   await toolsHost.getByLabel('处理资料').selectOption(material.id);
   await toolsHost.getByRole('button', { name: '生成讲义/摘要', exact: true }).click();
   await page.getByTestId('confirm-dialog').getByRole('button', { name: '继续', exact: true }).click();
    await toolsHost.getByText('生成讲义/摘要 · 执行结束，请查看原产物', { exact: false }).waitFor({ timeout: 30000 });
   const legacyHandout = await page.evaluate(async id => {
     const { runHandout } = await import('/src/pipelines/handout.ts');
     return runHandout(id, () => {});
   }, material.id);
   assert.ok(legacyHandout.handoutId, 'original handout pipeline dispatches through the same plugin service');
  await secondDevice.close(); await templatePage.close();
  await page.reload(); await shared.getByText('真实跨位置共享待办', { exact: true }).waitFor(); assert.equal(await shared.getByRole('checkbox').isChecked(), true);
  await cardHost.getByLabel('卡片资料').selectOption(material.id);
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width < 640 ? 844 : 1000 });
    for (const theme of ['light', 'dark', 'auto']) {
      await page.emulateMedia({ colorScheme: theme === 'auto' ? 'dark' : theme });
      await page.evaluate(async theme => { const { useSettings } = await import('/src/store/settings.ts'); useSettings.setState({ theme }); }, theme);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${theme}: no page horizontal overflow`);
      await page.screenshot({ path: path.join(output, `plugins-board-${theme}-${width}.png`) });
      for (const [name, learningPage] of [['cards', cardsFull], ['practice', practiceFull], ['review', reviewFull]]) {
        await learningPage.setViewportSize({ width, height: width < 640 ? 844 : 1000 });
        await learningPage.emulateMedia({ colorScheme: theme === 'auto' ? 'dark' : theme });
        await learningPage.evaluate(async theme => { const { useSettings } = await import('/src/store/settings.ts'); useSettings.setState({ theme }); }, theme);
        await learningPage.waitForTimeout(100);
        assert.equal(await learningPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}/${width}/${theme}: no horizontal overflow`);
        await learningPage.screenshot({ path: path.join(output, `learning-${name}-${theme}-${width}.png`) });
      }
    }
  }
  await chat.screenshot({ path: path.join(output, 'plugins-chat-1440.png') }); await reader.screenshot({ path: path.join(output, 'plugins-reader-1440.png') });
  // A real process service restart (same DB and files) does not depend on view callbacks.
   await learningRunner.close(); await app.close(); app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: botFixtureFetch }); await app.listen({ host: '127.0.0.1', port: apiPort });
   await full.reload(); await full.frameLocator('iframe[title="待办"]').getByText('真实跨位置共享待办', { exact: true }).waitFor({ timeout: 30000 }); assert.equal(await full.frameLocator('iframe[title="待办"]').getByRole('checkbox').isChecked(), true);
  await cardsFull.reload(); await cardsFull.getByLabel('卡片资料').selectOption(material.id);
  await cardsFull.getByText('已保存 1 张卡片', { exact: true }).waitFor();
  assert.equal(await cardsFull.getByRole('button', { name: '保留', exact: true }).getAttribute('aria-pressed'), 'true');
  await practiceFull.reload(); await practiceFull.getByLabel('练习资料').selectOption(material.id);
  await practiceFull.getByTestId('quiz-explain').getByText('正确答案：A', { exact: false }).waitFor();
  await reviewFull.reload(); await reviewFull.getByLabel('复习资料').selectOption(material.id);
  await reviewFull.getByText('已作答 2 次', { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  console.log(`Plugin platform UI passed: management via real controls, shared todo/cards across board/Chat/reader/page, native AI practice and original Markdown snapshots, answer-source labels, immutable submission sync, wrongbook review re-answer and original attempt counts, artifact receipts, independent instance, refresh and service restart, 360/390/1440 light/dark/system (including 27 learning-page screenshots). Screenshots: ${output}`);
} finally { await learningRunner?.close(); await browser?.close(); await web?.close(); await app.close(); store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
