#!/usr/bin/env node
// Real selection, storage and model requests; all model responses are mocked, no credentials/network needed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:5196';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const requests = [];
const scripted = [];
const body = request => JSON.stringify(request.messages);
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await context.addInitScript(() => {
    if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: {
      uiLanguage: 'zh-CN', providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://skills.test/v1', apiKey: 'test-only', serves: ['chat'], catalogId: '' }],
      llmModel: { providerId: 'fixture', model: 'fixture-model' }, thinkingEnabled: false,
    } }));
    window.skillImport = path => {
      const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
  });
  await context.route('https://skills.test/**', route => {
    const request = route.request().postDataJSON();
    if (!request.stream) return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '技能测试' } }] } });
    requests.push(request);
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [scripted.shift() ?? { delta: { content: '测试回答完成。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  const ids = await page.evaluate(async () => {
    const { db } = await window.skillImport('/src/store/db.ts');
    const { ensureBuiltinSkills } = await window.skillImport('/src/skills/store.ts');
    await ensureBuiltinSkills();
    const add = (name, body, extra = {}) => db.skills.add({ name, description: '测试规范', body, enabled: 1, builtin: 0, updatedAt: Date.now(), ...extra });
    const turn = await add('仅本轮规范', 'TURN_START_' + '完整规范。'.repeat(1600) + '_TURN_END');
    const pinned = await add('固定规范', 'PINNED_BODY_V1');
    const auto = await add('自动规范', 'AUTO_BODY_MUST_STAY_LAZY');
    await db.skillRefs.add({ skillId: turn, path: 'guide.md', body: 'REFERENCE_BODY_MUST_STAY_LAZY' });
    return { turn, pinned, auto };
  });
  const open = async () => {
    await page.getByTestId('chat-add').click();
    await page.getByRole('menuitem', { name: /技能/ }).click();
    await page.getByTestId('skill-picker-dialog').waitFor();
    await page.getByTestId('skill-scope-item').last().waitFor();
  };
  const close = async () => {
    await page.getByTestId('skill-picker-done').click();
    await page.getByTestId('skill-picker-dialog').waitFor({ state: 'detached' });
  };
  const send = async text => {
    await page.evaluate(async text => (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState().send(text), text);
  };
  await send('自动模式');
  assert.equal(requests.length, 1);
  assert.ok(!body(requests.at(-1)).includes('AUTO_BODY_MUST_STAY_LAZY'));
  assert.ok(!body(requests.at(-1)).includes('PINNED_BODY_V1'));
  console.log('PASS: automatic mode advertises metadata without eagerly loading bodies.');

  await open();
   assert.equal(await page.getByTestId('skill-tab-pinned').count(), 0, 'no forced activation pin UI');
  await page.locator('[data-testid="skill-scope-item"][data-skill-name="仅本轮规范"] .skill-picker__content').click();
  await page.waitForFunction(async id => (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState().turnSkillIds.includes(id), ids.turn);
   await page.locator('[data-testid="skill-scope-item"][data-skill-name="固定规范"] .skill-picker__content').click();
   await page.waitForFunction(async id => (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState().turnSkillIds.includes(id), ids.pinned);
  await close();
  await page.getByTestId('chat-active-skills').waitFor();
  await send('手动指定');
  assert.equal(requests.length, 2, 'explicit turn reaches the model exactly once');
  let request = body(requests.at(-1));
  assert.ok(request.includes('TURN_START_') && request.includes('_TURN_END'), 'full body beyond the old 6000-char cap');
  assert.ok(request.includes('PINNED_BODY_V1'));
  assert.equal(request.match(/PINNED_BODY_V1/g).length, 1);
  assert.ok(!request.includes('REFERENCE_BODY_MUST_STAY_LAZY'));
  assert.ok(!request.includes('AUTO_BODY_MUST_STAY_LAZY'));
  const state = await page.evaluate(async () => {
    const s = (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState();
    const { db } = await window.skillImport('/src/store/db.ts');
    return { turn: s.turnSkillIds, scope: s.skillIds, session: await db.chatSessions.get(s.activeId), tools: s.messages.at(-1).tools };
  });
  assert.deepEqual(state.turn, []);
  assert.equal(state.scope, undefined);
   assert.equal(state.session.pinnedSkillIds, undefined);
  assert.equal(state.tools.filter(tool => tool.id?.startsWith('explicit-skill-') && tool.status === 'done').length, 2);
  console.log('PASS: explicit UI selections load complete bodies before the model, preserve permission scope, and show real loading receipts.');

  await send('下一轮');
  request = body(requests.at(-1));
   assert.equal(request.match(/TURN_START_/g).length, 1, 'instructions are reused through retained model history');
   assert.ok(request.includes('PINNED_BODY_V1'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(async () => (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState().loaded);
  await page.evaluate(async id => { const { db } = await window.skillImport('/src/store/db.ts'); await db.skills.update(id, { body: 'PINNED_BODY_V2', updatedAt: Date.now() }); }, ids.pinned);
  await send('刷新并更新规范');
   assert.ok(!body(requests.at(-1)).includes('PINNED_BODY_V2'), 'updated bodies remain lazy until actual activation');
   assert.ok(!body(requests.at(-1)).includes('PINNED_BODY_V1'));
   await page.evaluate(async id => { (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState().setTurnSkillIds([id]); }, ids.turn);
   await send('再次指定同一规范');
   assert.equal(body(requests.at(-1)).match(/TURN_START_/g).length, 1, 'explicit reuse never duplicates a retained body');
   await send('压缩边界');
   await page.evaluate(async () => {
     const { db } = await window.skillImport('/src/store/db.ts');
     const s = (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState();
     const boundary = (await db.chats.where('sessionId').equals(s.activeId).sortBy('createdAt')).findLast(row => row.role === 'user');
     await db.chatSessions.update(s.activeId, { pinnedSkillIds: [999999], contextCheckpoint: { fromId: boundary.id, source: boundary.content } });
   });
   await send('压缩后无关问题');
   assert.ok(!body(requests.at(-1)).includes('TURN_START_'));
   assert.ok(!body(requests.at(-1)).includes('PINNED_BODY_V2'));
   console.log('PASS: history reuse survives reload, duplicate invocations reuse one body; edits invalidate old bodies and compression does not resurrect old selections or legacy pins.');

  await page.evaluate(async id => {
    const { useCourseChat } = await window.skillImport('/src/store/courseChat.ts');
    const s = useCourseChat.getState();
    s.setTurnSkillIds([id]);
    await s.send('可重试的一轮');
    const last = useCourseChat.getState().messages.at(-1);
    await useCourseChat.getState().retryMessage(last.key);
  }, ids.turn);
  assert.ok(body(requests.at(-1)).includes('_TURN_END'), 'regeneration retains original one-turn selection');
  await send('重试后的新一轮');
   assert.equal(body(requests.at(-1)).match(/TURN_START_/g).length, 1);
   console.log('PASS: retries preserve explicit invocation and retained instructions are reused without repeated loading.');

   scripted.push({ delta: { tool_calls: [{ index: 0, id: 'lazy-skill', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: '/skills/自动规范' }) } }] }, finish_reason: 'tool_calls' });
   await send('自动按需使用规范');
   assert.ok(!body(requests.at(-2)).includes('AUTO_BODY_MUST_STAY_LAZY'));
   assert.equal(body(requests.at(-1)).match(/AUTO_BODY_MUST_STAY_LAZY/g).length, 1);
   await page.evaluate(async id => { (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState().setTurnSkillIds([id]); }, ids.auto);
   await send('显式复用刚读取的规范');
   assert.equal(body(requests.at(-1)).match(/AUTO_BODY_MUST_STAY_LAZY/g).length, 1);
   console.log('PASS: lazy model-driven activation persists its real body and deduplicates later explicit invocation.');

  const beforeBlocked = requests.length;
  const blocked = await page.evaluate(async ids => {
    const { useCourseChat } = await window.skillImport('/src/store/courseChat.ts');
    const { db } = await window.skillImport('/src/store/db.ts');
    const s = useCourseChat.getState();
    s.setSkillIds([]);
    s.setTurnSkillIds([ids.turn]);
    await s.send('越界选择');
    const scopeError = useCourseChat.getState().messages.at(-1).content;
    useCourseChat.getState().setSkillIds(undefined);
    await db.skills.update(ids.turn, { enabled: 0 });
    await useCourseChat.getState().send('停用选择');
    const disabledError = useCourseChat.getState().messages.at(-1).content;
    await db.skills.update(ids.turn, { enabled: 1 });
    return { scopeError, disabledError };
  }, ids);
  assert.equal(requests.length, beforeBlocked);
  assert.match(blocked.scopeError, /不在当前技能范围/);
  assert.match(blocked.disabledError, /已停用/);
  console.log('PASS: out-of-scope and disabled skills fail visibly without a model call.');

  const failures = await page.evaluate(async ids => {
    const { activateSkills, assertSkillBudget } = await window.skillImport('/src/skills/activation.ts');
    const { db } = await window.skillImport('/src/store/db.ts');
    const errors = [];
    for (const [id, changes] of [[ids.auto, { body: '' }], [ids.auto, { body: 'MCP', mcpRequired: ['missing-server'] }]]) {
      await db.skills.update(id, changes);
      try { await activateSkills([id]); } catch (error) { errors.push(error.message); }
    }
    try { await activateSkills([999999999]); } catch (error) { errors.push(error.message); }
    const loaded = await activateSkills([ids.turn, ids.turn]);
    try { assertSkillBudget(-1, loaded); } catch (error) { errors.push(error.message); }
    return { errors, ids: loaded.ids };
  }, ids);
  assert.equal(failures.errors.length, 4);
  assert.deepEqual(failures.ids, [ids.turn]);
  assert.match(failures.errors.join('\n'), /正文为空/);
  assert.match(failures.errors.join('\n'), /MCP/);
  assert.match(failures.errors.join('\n'), /没有被截断/);
  console.log('PASS: empty/deleted skills, missing dependencies and budget overflow are explicit errors; duplicate activations are deduplicated.');

  const beforeQa = requests.length;
  await page.evaluate(async ids => {
    const { db } = await window.skillImport('/src/store/db.ts');
    const { runQa } = await window.skillImport('/src/harness/qaRunner.ts');
    for (const [sessionId, materialKind] of [[80001, undefined], [80002, 'page']]) {
      await db.chatSessions.put({ id: sessionId, videoId: 'fixture-video', title: 'QA', createdAt: Date.now(), pinnedSkillIds: [ids.pinned] });
      await runQa({ sessionId, videoId: 'fixture-video', text: 'QA test', materialKind, explicitSkillIds: [ids.turn] });
    }
  }, ids);
  assert.equal(requests.length, beforeQa + 2);
  for (const req of requests.slice(beforeQa)) {
     assert.ok(!body(req).includes('PINNED_BODY_V2'), 'legacy pins never eagerly load QA instructions');
    assert.ok(body(req).includes('_TURN_END'));
    assert.ok(!body(req).includes('REFERENCE_BODY_MUST_STAY_LAZY'));
  }
   console.log('PASS: video and PDF QA use the same explicit activation path in their actual model requests.');

   await page.evaluate(async id => {
     const { db } = await window.skillImport('/src/store/db.ts');
     await db.skills.update(id, { body: 'HUGE_BEGIN_' + '完整规范。'.repeat(70000) + '_HUGE_END', mcpRequired: undefined, updatedAt: Date.now() });
   }, ids.auto);
   scripted.push({ delta: { tool_calls: [{ index: 0, id: 'huge-skill', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: '/skills/自动规范' }) } }] }, finish_reason: 'tool_calls' });
   const beforeHuge = requests.length;
   await send('按需读取超大规范');
   assert.equal(requests.length, beforeHuge + 1, 'oversized body is never sent partially to the model');
   assert.match(await page.evaluate(async () => (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState().messages.at(-1).content), /没有被截断/);
   console.log('PASS: oversized lazy body fails visibly before another model request, including the tool-free closing round.');

  // Mobile controls remain reachable, including with a reduced visual viewport.
   await page.evaluate(async () => { const s = (await window.skillImport('/src/store/courseChat.ts')).useCourseChat.getState(); s.setTurnSkillIds([]); s.setSkillIds(undefined); });
  await open();
  for (const height of [740, 480]) {
    await page.setViewportSize({ width: 360, height });
    await page.waitForFunction(() => {
      const rect = document.querySelector('[data-testid="skill-picker-done"]').getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    });
    assert.equal(await page.getByTestId('skill-picker-dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  }
   assert.deepEqual(errors, []);
   console.log('PASS: desktop/mobile picker has no horizontal overflow or page errors.');

   await close();
   await page.setViewportSize({ width: 1280, height: 900 });
   await page.evaluate(async () => {
     const { db } = await window.skillImport('/src/store/db.ts');
     await db.videos.put({ id: 'skill-panel', name: '技能面板测试', size: 1, mimeType: 'video/mp4', duration: 100, createdAt: Date.now(), status: 'transcribed' });
     await db.chatSessions.add({ videoId: 'skill-panel', title: '技能面板', createdAt: Date.now(), pinnedSkillIds: [999999] });
   });
   await page.goto(`${base}/#/player/skill-panel`);
   const panelTab = page.getByTestId('panel-tab-chat');
   if (!(await panelTab.isVisible().catch(() => false))) await page.getByTestId('study-assistant-toggle').click();
   await panelTab.click();
   await page.getByTestId('panel-chat-add').click();
   await page.getByRole('menuitem', { name: /技能/ }).click();
   await page.locator('[data-testid="skill-scope-item"][data-skill-name="仅本轮规范"] .skill-picker__content').click();
   await close();
   const panelSend = async text => {
     const before = requests.length;
     await page.getByRole('textbox', { name: '给学习助手发送消息' }).fill(text);
     const response = page.waitForResponse(response => response.url().startsWith('https://skills.test/') && response.request().postDataJSON()?.stream === true);
     await page.getByRole('textbox', { name: '给学习助手发送消息' }).press('Enter');
     await response;
     await page.getByTestId('chat-msg-ai').last().filter({ hasText: '测试回答完成。' }).waitFor();
     assert.equal(requests.length, before + 1);
   };
   await panelSend('面板明确指定');
   assert.equal(body(requests.at(-1)).match(/TURN_START_/g).length, 1);
   await panelSend('面板后续相关任务');
   assert.equal(body(requests.at(-1)).match(/TURN_START_/g).length, 1, 'course panel replays actual activation traces');
   assert.deepEqual(errors, []);
   console.log('PASS: actual course panel invokes once, ignores legacy pins and reuses loaded instructions in subsequent requests.');
} finally { await browser.close(); }
