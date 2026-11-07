import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-cloud-models-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret'), FILES_DIR: path.join(directory, 'files') });
const { buildServer } = await import('../apps/api/src/server.ts');
const upstream = [];
let upstreamStatus = 200;
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  upstream.push({ url, headers: init.headers });
  if (upstreamStatus !== 200) return Response.json({ error: 'not-supported' }, { status: upstreamStatus });
  return String(url).includes('after_id=')
    ? Response.json({ data: [{ id: 'openai/gpt-4o' }], has_more: false })
    : Response.json({ data: [{ id: 'catalog-model', context_window: 64000 }], has_more: true, last_id: 'page/1' });
} });
let browser, web;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { startWebFixture } = await import('./lib/web-fixture.mjs');
  web = await startWebFixture(`http://127.0.0.1:${app.server.address().port}`);
  const origin = web.origin;
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://models.dev/api.json*', route => route.fulfill({ json: {
    openai: { models: { 'gpt-4o': { modalities: { input: ['text', 'image'], output: ['text'] }, tool_call: true, limit: { context: 128000, output: 8192 } } } },
    reseller: { models: { 'gpt-4o': { modalities: { input: ['text'], output: ['text'] }, limit: { context: 32000 } } } },
    fixture: { name: 'Fixture Provider', api: 'https://fixture.example/v1', npm: '@ai-sdk/openai-compatible', models: {
      'catalog-model': { name: 'Catalog Model', modalities: { input: ['text', 'image'], output: ['text'] }, tool_call: true, reasoning: true, limit: { context: 128000, output: 8192 } },
      'catalog-only-model': { name: 'Catalog only', modalities: { input: ['text'], output: ['text'] } },
    } },
  } }));
  await page.goto(`${origin}/#/setup`);
  const assertDesktopSetupLayout = async () => {
    const layout = await page.locator('.ob__panel').evaluate(panel => {
      const scene = panel.querySelector('.ob__scene');
      const bounds = panel.getBoundingClientRect();
      return {
        height: bounds.height,
        expectedHeight: Math.min(640, innerHeight - 64),
        withinViewport: bounds.top >= 0 && bounds.bottom <= innerHeight,
        pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
        sceneScrolls: scene.scrollHeight > scene.clientHeight,
        overflow: getComputedStyle(scene).overflowY,
        visualHeight: panel.querySelector('.ob__visual').getBoundingClientRect().height,
      };
    });
    assert.equal(layout.height, layout.expectedHeight, 'setup canvas height depends only on the desktop viewport, not form length');
    assert.ok(layout.withinViewport, 'setup canvas stays inside the desktop viewport');
    assert.equal(layout.pageScrolls, false, 'long setup forms never make the desktop page scroll');
    assert.equal(layout.overflow, 'auto', 'desktop form content has its own scroll container');
    assert.equal(layout.visualHeight, layout.height - 32, 'illustration fills the same fixed-height canvas at every step');
    return layout;
  };
  await page.getByRole('button', { name: '开始', exact: true }).waitFor();
  await assertDesktopSetupLayout();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByLabel('一次性初始化密钥', { exact: true }).fill(fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim());
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByLabel('密码', { exact: true }).fill('test-password-12345');
  await page.getByRole('button', { name: '创建管理员', exact: true }).click();
  await page.getByLabel('你的称呼', { exact: true }).fill('模型测试');
  await assertDesktopSetupLayout();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByTestId('provider-add-card').waitFor();
  assert.equal(await page.getByTestId('cloud-models-save').count(), 0, 'clean onboarding hides the save action');
  await page.getByTestId('model-meta-updated-at').locator('time').waitFor();
  assert.equal((await assertDesktopSetupLayout()).sceneScrolls, true, 'long model setup scrolls inside the right column');
  for (const viewport of [{ width: 1280, height: 768 }, { width: 960, height: 600 }, { width: 1280, height: 400 }]) {
    await page.setViewportSize(viewport);
    await assertDesktopSetupLayout();
    await page.getByTestId('onboarding-models-done').scrollIntoViewIfNeeded();
    await assertDesktopSetupLayout();
    assert.ok(await page.getByTestId('onboarding-models-done').evaluate(element => {
      const button = element.getBoundingClientRect();
      const scene = element.closest('.ob__scene').getBoundingClientRect();
      return button.top >= scene.top && button.bottom <= scene.bottom;
    }), 'completion remains reachable inside the scrollable form, including short desktop windows');
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator('.ob__scene').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/onboarding-models-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'onboarding editor stays within the mobile viewport');
  assert.ok(await page.getByTestId('card-api').evaluate(element => element.getBoundingClientRect().right <= innerWidth), 'onboarding cards are not clipped by the outer grid');
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/onboarding-models-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByTestId('provider-preset-search').evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.getByTestId('provider-preset-search').fill('Fixture Provider');
  await page.getByRole('option').filter({ hasText: 'Fixture Provider' }).waitFor();
  await page.getByTestId('provider-preset-search').press('ArrowDown');
  await page.getByTestId('provider-preset-search').press('Enter');
  await page.getByTestId('api-key-draft').fill('secret-for-server-only');
  await page.getByTestId('provider-draft-save').click();
  await page.getByTestId('provider-back').waitFor();
  assert.equal(await page.getByTestId('card-models').count(), 0, 'provider details do not show the default-model picker');
  await assertDesktopSetupLayout();
  const noBrowserKey = async () => assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('secret-for-server-only'));
  await noBrowserKey();
  await page.getByText(/2 个可用模型/).first().waitFor();
  assert.equal(upstream.length, 2, 'saving a connection immediately fetches its paginated model list');
  await page.getByTestId('discovered-model-select').click();
  assert.equal(await page.getByRole('button', { name: '添加 catalog-only-model', exact: true }).count(), 0, 'reference catalog never invents candidates absent from this connection');
  await page.getByRole('button', { name: '添加 catalog-model', exact: true }).click();
  await page.getByTestId('saved-models').getByText('Catalog Model', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('model-editor').count(), 0, 'adding a discovered model saves it directly without opening the editor');
  assert.equal(await page.getByTestId('discovered-model-select').getAttribute('aria-expanded'), 'true', 'candidate list stays open for further additions');
  assert.equal(await page.getByRole('button', { name: '添加 catalog-model', exact: true }).count(), 0, 'added models leave the candidate list');
  await page.getByRole('button', { name: '编辑 Catalog Model', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).getAttribute('placeholder'), '128000');
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '64000', 'direct add retains metadata declared by the connection');
  assert.equal(await page.getByRole('checkbox', { name: '图片理解', exact: true }).isChecked(), true, 'direct add derives uses from catalog capabilities');
  await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).fill('96000');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  const readConfig = async () => (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  const saved = await readConfig();
  assert.equal(saved.providers[0].catalogId, 'fixture');
  assert.equal(saved.providers[0].baseUrl, 'https://fixture.example/v1');
  assert.equal(saved.providers[0].configured, true);
  assert.equal(saved.providers[0].apiKey, undefined);
  await noBrowserKey();
  const id = saved.providers[0].id;
  assert.equal(saved.providers[0].keyHint, '••••only');
  assert.equal(await page.getByTestId(`provider-key-hint-${id}`).innerText(), '••••only');
  assert.equal(await page.getByTestId(`api-key-${id}`).count(), 0, 'saved keys are shown as list items, not empty credential inputs');
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/2 个可用模型/).first().waitFor();
  assert.equal(upstream[0].url, 'https://fixture.example/v1/models');
  assert.equal(upstream[1].url, 'https://fixture.example/v1/models?after_id=page%2F1', 'gateway preserves provider pagination');
  assert.equal(upstream[0].headers.authorization, 'Bearer secret-for-server-only');
  assert.equal(await page.getByTestId('saved-models').getByRole('button', { name: /^编辑 / }).count(), 1, 'discovery does not automatically add models');
  if (await page.getByTestId('discovered-model-select').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('discovered-model-select').click();
  }
  await page.getByRole('button', { name: '添加 openai/gpt-4o', exact: true }).click();
  await page.getByTestId('saved-models').getByText('openai/gpt-4o', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('model-editor').count(), 0, 'official catalog models are also added without an editor');
  await page.getByRole('button', { name: '编辑 openai/gpt-4o', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).getAttribute('placeholder'), '128000');
  assert.match(await page.getByTestId('model-metadata-details').innerText(), /能力来源 openai/);
  assert.equal(await page.getByRole('button', { name: /模型能力来源/ }).count(), 0, 'common models need no manual source selection');
  assert.equal(await page.getByRole('checkbox', { name: '图片理解', exact: true }).isChecked(), true, 'official vision capability preselects the model use');
  await page.getByTestId('model-editor').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('saved-models').getByText('openai/gpt-4o', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑 Catalog Model', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '96000');
  await page.getByTestId('model-editor').getByRole('button', { name: '取消', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await page.getByTestId('provider-back').click();
  await page.getByTestId('card-models').waitFor();
  await page.getByTestId('model-button-llmModel').evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.getByTestId('model-button-llmModel').click();
  await page.waitForFunction(() => {
    const popover = document.querySelector('[data-model-picker="llmModel"]');
    return popover && getComputedStyle(popover).opacity === '1' && !popover.hasAttribute('data-entering');
  });
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/onboarding-model-picker.png') });
  await page.getByTestId('model-option-catalog-model').click();
  await assertDesktopSetupLayout();
  // Completion must save pending model choices, and failures must keep the editor open.
  await page.route('**/api/v1/cloud/model-settings', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: 'test_save_failed' } }) : route.continue());
  await page.getByTestId('onboarding-models-done').click();
  await page.getByRole('alert').filter({ hasText: 'test_save_failed' }).waitFor();
  await page.getByTestId('onboarding-models-done').waitFor();
  await page.unroute('**/api/v1/cloud/model-settings');
  await page.getByTestId('onboarding-models-done').click();
  await page.waitForFunction(() => !document.querySelector('.ob'));
  assert.equal((await readConfig()).llmModel.model, 'catalog-model');
  await page.goto(`${origin}/#/settings/models`);
  await page.reload();
  await page.getByTestId(`provider-summary-${id}`).click();
  assert.equal(await page.getByTestId('cloud-models-save').count(), 0, 'clean settings hide the save action');
  assert.equal(await page.getByTestId('cloud-models-save-actions').count(), 0, 'clean settings do not reserve an empty save dock');
  assert.equal(await page.getByRole('button', { name: '使用服务器版本…', exact: true }).count(), 0, 'server-version recovery is not a routine action');
  assert.equal(await page.getByTestId(`field-api-key-${id}`).getByTestId(`provider-accounts-${id}`).count(), 1, 'key input and account management belong to the same API Key field');
  assert.equal(await page.getByTestId(`field-api-key-${id}`).locator('input[type="password"]').count(), 0, 'key management has no duplicate always-visible input');
  await page.getByTestId(`provider-name-${id}`).fill('Renamed connection');
  const assertSaveDock = async () => {
    const dock = page.getByTestId('cloud-models-save-actions');
    await dock.waitFor();
    assert.ok(await dock.evaluate(element => element.closest('[data-testid="settings-modal"]') && element.parentElement.classList.contains('settings-actions-slot')), 'save actions stay inside the modal focus scope, outside its scroll container');
    const before = await dock.boundingBox();
    await page.getByTestId('settings-module-models').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const after = await dock.boundingBox();
    const content = await page.getByTestId('settings-module-models').boundingBox();
    assert.ok(content.y + content.height <= after.y + 1, 'save actions reserve their own space instead of covering fields');
    assert.equal(after.y, before.y, 'scrolling settings never moves the save dock');
    assert.ok(after.x >= 0 && after.y >= 0 && after.x + after.width <= (await page.viewportSize()).width && after.y + after.height <= (await page.viewportSize()).height, 'save actions stay within the viewport');
    await page.getByTestId('settings-module-models').evaluate(element => { element.scrollTop = 0; });
  };
  await assertSaveDock();
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-save-desktop.png') });
  await page.getByTestId(`provider-name-${id}`).fill(saved.providers[0].name);
  await page.getByTestId('cloud-models-save').waitFor({ state: 'detached' });
  await page.getByTestId(`provider-name-${id}`).fill('Renamed connection');
  assert.equal(await page.getByTestId('btn-check-models').innerText(), '保存连接并获取模型', 'display name changes are not mistaken for a saved connection');
  await page.getByTestId('saved-models').getByText('openai/gpt-4o', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑 Catalog Model', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '上下文窗口', exact: true }).inputValue(), '96000', 'onboarding capabilities survive reload in settings');
  await page.getByTestId('model-editor').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/2 个可用模型/).first().waitFor();
  await page.getByTestId('cloud-models-save').waitFor({ state: 'detached' });
  assert.ok(upstream.every(r => r.headers.authorization === 'Bearer secret-for-server-only'), 'blank editor keys preserve credentials');
  await noBrowserKey();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await page.getByTestId('provider-back').click();
  await page.getByTestId('provider-add-card').waitFor();
  assert.equal(await page.getByRole('heading', { name: '云端账号与权限', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('provider-add-card').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile editor stays within the viewport');
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-mobile.png') });
  // Saving rotated credentials succeeds even when the provider has no model-list endpoint.
  await page.getByTestId(`provider-summary-${id}`).click();
  await page.getByRole('button', { name: '更换 Key', exact: true }).click();
  assert.equal(await page.getByTestId(`field-api-key-${id}`).locator('input[type="password"]').count(), 1, 'replacing a key opens exactly one credential input');
  await page.getByTestId(`api-key-${id}`).fill('rotated-secret');
  await assertSaveDock();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'key accounts and floating actions fit mobile screens');
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-save-mobile.png') });
  assert.equal(await page.getByTestId('btn-check-models').innerText(), '保存连接并获取模型');
  upstreamStatus = 404;
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/接口未提供模型列表/).first().waitFor();
  assert.equal(await page.getByTestId(`api-key-${id}`).count(), 0, 'saved credentials and their form are cleared after a discovery failure');
  assert.equal((await readConfig()).llmModel.model, 'catalog-model', 'connection save preserves defaults');
  assert.equal((await readConfig()).providers[0].configured, true);
  assert.equal(upstream.at(-1).headers.authorization, 'Bearer rotated-secret');
  upstreamStatus = 200;
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/2 个可用模型/).first().waitFor();

  // Another page changes the connection; this editor must keep its key draft and show a conflict.
  const latest = await readConfig();
  const changed = await context.request.put(`${origin}/api/v1/cloud/providers/${id}`, { data: {
    provider: { ...latest.providers[0], name: 'Externally changed' }, modelRevision: latest.modelRevision,
  } });
  assert.equal(changed.status(), 200);
  await page.getByRole('button', { name: '更换 Key', exact: true }).click();
  await page.getByTestId(`api-key-${id}`).fill('unsaved-conflict-secret');
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/服务器上的模型设置已被其他页面修改/).first().waitFor();
  assert.equal(await page.getByTestId(`api-key-${id}`).inputValue(), 'unsaved-conflict-secret');
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('unsaved-conflict-secret'));
  assert.equal(await page.getByTestId('cloud-models-save').isDisabled(), true, 'conflicts cannot be retried with a stale version');
  await page.getByRole('button', { name: '使用服务器版本…', exact: true }).click();
  await page.getByTestId('confirm-dialog-danger').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByTestId(`api-key-${id}`).inputValue(), 'unsaved-conflict-secret', 'cancelling recovery preserves credentials and the draft');
  await page.getByRole('button', { name: '使用服务器版本…', exact: true }).click();
  await page.getByTestId('confirm-dialog-danger').getByRole('button', { name: '放弃修改并载入', exact: true }).click();
  await page.getByTestId('provider-add-card').waitFor();
  await page.getByTestId(`provider-summary-${id}`).click();
  assert.equal(await page.getByTestId(`api-key-${id}`).count(), 0);
  assert.equal(await page.getByRole('button', { name: '使用服务器版本…', exact: true }).count(), 0, 'recovery disappears after loading the latest version');

  // Account changes save immediately in the same API Key section, not in the model draft.
  const accounts = page.getByTestId(`provider-accounts-${id}`);
  await accounts.getByRole('button', { name: '添加 Key', exact: true }).click();
  assert.equal(await page.getByTestId(`field-api-key-${id}`).locator('input[type="password"]').count(), 1, 'adding a key uses the same single-input area');
  await accounts.getByLabel('Key 名称（可选）', { exact: true }).fill('Secondary account');
  await accounts.getByLabel('API Key', { exact: true }).fill('account-secret-for-server-only');
  await page.getByTestId('cloud-models-save').click();
  await page.getByRole('alert').filter({ hasText: '当前 API Key 尚未保存' }).waitFor();
  await page.route(`**/api/v1/cloud/providers/${id}/accounts`, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { error: 'test_key_save_failed' } }) : route.continue());
  await accounts.getByRole('button', { name: '保存 Key', exact: true }).click();
  await accounts.getByRole('alert').filter({ hasText: 'test_key_save_failed' }).waitFor();
  assert.equal(await accounts.getByLabel('API Key', { exact: true }).inputValue(), 'account-secret-for-server-only', 'failed key saves retain the single form for retry');
  await page.unroute(`**/api/v1/cloud/providers/${id}/accounts`);
  await accounts.getByRole('button', { name: '保存 Key', exact: true }).click();
  await accounts.getByText('Secondary account', { exact: false }).waitFor();
  assert.equal(await accounts.getByLabel('API Key', { exact: true }).count(), 0, 'saved account secrets and the input form are removed');
  assert.equal((await readConfig()).providers[0].accounts[0].name, 'Secondary account');
  const account = (await readConfig()).providers[0].accounts[0];
  assert.equal(account.keyHint, '••••only');
  assert.equal(await accounts.getByTestId(`account-key-hint-${account.id}`).innerText(), '••••only', 'named accounts display their identifying suffix in the key list');
  await page.getByTestId('cloud-models-save').waitFor({ state: 'detached' });
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('account-secret-for-server-only'));
  await page.getByTestId('field-api-key-' + id).evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-unified-keys-mobile.png') });
  await accounts.getByRole('button', { name: '删除', exact: true }).click();
  await accounts.getByText('Secondary account', { exact: false }).waitFor({ state: 'detached' });
  await page.getByTestId(`provider-default-key-${id}`).getByText('当前使用', { exact: true }).waitFor();
  await accounts.getByRole('button', { name: '添加 Key', exact: true }).click();
  await accounts.getByLabel('API Key', { exact: true }).fill('discarded-extra-key');
  await accounts.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await accounts.getByLabel('API Key', { exact: true }).count(), 0, 'cancel removes the form and its secret');
  await page.getByTestId('cloud-models-save').waitFor({ state: 'detached' });
  await accounts.getByRole('button', { name: '更换 Key', exact: true }).click();
  await accounts.getByLabel('API Key', { exact: true }).fill('replacement-from-unified-form');
  await accounts.getByRole('button', { name: '保存 Key', exact: true }).click();
  await accounts.getByLabel('API Key', { exact: true }).waitFor({ state: 'detached' });
  await page.getByTestId('btn-check-models').click();
  await page.getByText(/2 个可用模型/).first().waitFor();
  assert.equal(upstream.at(-1).headers.authorization, 'Bearer replacement-from-unified-form');
  assert.equal(await page.getByTestId(`provider-key-hint-${id}`).innerText(), '••••form', 'replacing a credential updates its display suffix');

  // Purpose-first main/backup editing uses the saved model library, not raw IDs.
  const presets = page.getByTestId('model-presets');
  const botRoute = page.getByTestId('model-route-bot');
  const chatRoute = page.getByTestId('model-route-chat');
  const refKey = model => JSON.stringify([id, model]);
  assert.equal(await presets.getByRole('textbox').count(), 0, 'routing needs neither plan names nor hand-entered model IDs');
  assert.equal(await botRoute.getByLabel('Bot 助手 · 主模型', { exact: true }).inputValue(), refKey('catalog-model'), 'builtin routes display the actual default');
  assert.equal(await botRoute.getByRole('button', { name: '添加备用模型', exact: true }).isEnabled(), true);
  await botRoute.getByRole('button', { name: '添加备用模型', exact: true }).click();
  await botRoute.getByLabel('Bot 助手 · 选择备用模型', { exact: true }).selectOption(refKey('openai/gpt-4o'));
  assert.equal(await botRoute.getByLabel('Bot 助手 · 备用模型 1', { exact: true }).inputValue(), refKey('openai/gpt-4o'));
  assert.equal(await botRoute.getByRole('button', { name: '添加备用模型', exact: true }).isEnabled(), false, 'duplicate backup models cannot be added');
  await botRoute.getByRole('button', { name: 'Bot 助手 · 备用模型 1优先使用', exact: true }).click();
  assert.equal(await botRoute.getByLabel('Bot 助手 · 主模型', { exact: true }).inputValue(), refKey('openai/gpt-4o'));
  assert.equal(await chatRoute.getByLabel('普通聊天 / 课程问答 · 主模型', { exact: true }).inputValue(), refKey('catalog-model'), 'editing Bot does not change chat');
  await page.route('**/api/v1/cloud/model-settings', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: 'test_dock_save_failed' } }) : route.continue());
  await page.getByTestId('cloud-models-save').click();
  await page.getByTestId('cloud-models-save-actions').getByRole('alert').filter({ hasText: 'test_dock_save_failed' }).waitFor();
  await assertSaveDock();
  assert.equal(await botRoute.getByLabel('Bot 助手 · 主模型', { exact: true }).inputValue(), refKey('openai/gpt-4o'), 'failed floating saves keep priorities intact');
  await page.unroute('**/api/v1/cloud/model-settings');
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  let presetConfig = await readConfig();
  await page.getByTestId('cloud-models-save').waitFor({ state: 'detached' });
  const botPlan = presetConfig.modelPresets.find(p => p.id === presetConfig.modelRoutes.byPurpose.bot);
  assert.deepEqual(botPlan.candidates.map(c => c.ref.model), ['openai/gpt-4o', 'catalog-model']);
  assert.equal(botPlan.policy.allowCrossProvider, false);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('[data-slot="toast"]'));
  await botRoute.scrollIntoViewIfNeeded();
  assert.equal(await botRoute.evaluate(element => element.scrollWidth > element.clientWidth), false, 'main/backup controls fit the mobile card');
  assert.ok(await botRoute.getByRole('button').evaluateAll(buttons => buttons.every(button => getComputedStyle(button).transform === 'none' && button.getBoundingClientRect().height >= 44)), 'mobile actions avoid clipped GPU layers and retain 44px touch targets');
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/model-routes-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.reload();
  await botRoute.getByLabel('Bot 助手 · 主模型', { exact: true }).waitFor();
  await botRoute.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/model-routes-desktop.png'), animations: 'disabled' });
  await botRoute.screenshot({ path: path.join(os.tmpdir(), 'opencode/model-routes-card.png'), animations: 'disabled' });
  await botRoute.getByLabel('Bot 助手 · 主模型', { exact: true }).waitFor();
  assert.equal(await botRoute.getByLabel('Bot 助手 · 主模型', { exact: true }).inputValue(), refKey('openai/gpt-4o'));
  await botRoute.getByRole('button', { name: 'Bot 助手 · 移除备用模型 1', exact: true }).click();
  assert.equal(await botRoute.getByText('未设置备用，失败后不会换模型', { exact: true }).count(), 1);
  await botRoute.getByRole('button', { name: '恢复跟随默认', exact: true }).click();
  assert.equal(await botRoute.getByLabel('Bot 助手 · 主模型', { exact: true }).inputValue(), refKey('catalog-model'));
  await presets.getByText('未使用的已保存方案（1）', { exact: true }).click();
  await presets.getByRole('button', { name: `删除未使用方案 ${botPlan.name}`, exact: true }).click();
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  assert.ok(!(await readConfig()).modelPresets.some(p => p.id === botPlan.id));
  await page.getByTestId(`provider-summary-${id}`).click();

  // Deleting the active provider clears every default instead of silently changing providers.
  await page.getByTestId(`provider-remove-${id}`).click();
  const deletion = page.getByTestId('confirm-dialog-danger');
  await deletion.getByText(/清空聊天的默认模型/).waitFor();
  await deletion.getByRole('button', { name: '删除', exact: true }).click();
  assert.equal((await readConfig()).providers.length, 1, 'deletion stays in the draft until explicitly saved');
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  const deleted = await readConfig();
  assert.equal(deleted.providers.length, 0);
  assert.deepEqual(deleted.llmModel, { providerId: '', model: '' });
  // Skipping a new in-memory connection must not save its credentials or config.
  await page.goto(`${origin}/#/setup`);
  await page.reload();
  await page.getByTestId('provider-add-card').click();
  assert.equal(await page.getByTestId('card-models').count(), 0, 'new connections do not show default-model selection');
  assert.equal(await page.getByTestId('model-presets').count(), 0, 'custom providers do not show main/backup model settings');
  await page.getByTestId('provider-name-draft').fill('Discarded provider');
  await page.getByTestId('base-url-draft').fill('https://discard.example/v1');
  await page.getByTestId('api-key-draft').fill('discard-this-secret');
  await page.getByRole('button', { name: '稍后再说', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.ob'));
  assert.equal((await readConfig()).providers.length, 0);
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('discard-this-secret'));
  // Older configurations may contain dangling references, including a previously hidden decision slot.
  const legacy = { ...await readConfig(), llmModel: { providerId: 'deleted', model: 'old-chat' },
    decisionModel: { providerId: 'deleted', model: 'old-decision' } };
  await page.route('**/api/v1/cloud/config', route => route.request().method() === 'GET'
    ? route.fulfill({ json: legacy }) : route.continue());
  await page.goto(`${origin}/#/settings/models`);
  await page.reload();
  await page.getByText('有 2 项默认模型配置需要修复。你仍可独立保存连接并获取模型列表。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '定位并修复', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'model-button-llmModel');
  assert.equal(await page.getByTestId('model-button-llmModel').getAttribute('aria-invalid'), 'true');
  await page.getByRole('button', { name: '清除选择，稍后配置', exact: true }).click();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByTestId('confirm-dialog-danger').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('model-button-decisionModel').waitFor();
  await page.getByTestId('cloud-models-save').click();
  await page.getByRole('alert').filter({ hasText: '请先修复下方默认模型配置' }).waitFor();
  await page.getByRole('button', { name: '不使用决策模型', exact: true }).click();
  await page.unroute('**/api/v1/cloud/config');
  await page.getByTestId('cloud-models-save').click();
  await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
  assert.deepEqual((await readConfig()).decisionModel, { providerId: '', model: '' });
  await page.getByRole('button', { name: '添加 OpenCode Go', exact: true }).click();
  await page.getByText('连接已保存到服务器', { exact: true }).waitFor();
  await page.getByTestId('provider-summary-opencode-go').click();
  await page.getByTestId('field-api-key-opencode-go').getByText('OPENCODE_GO_API_KEY', { exact: true }).waitFor();
  const goConfig = await readConfig();
  assert.equal(goConfig.providers.find(p => p.id === 'opencode-go').configured, false, 'no test credential is installed');
  await page.getByRole('button', { name: '刷新路由与用量', exact: true }).click();
  await page.getByText('已停用用途：无；熔断记录：0', { exact: true }).waitFor();
  const discovery = await context.request.get(`${origin}/api/v1/cloud/model-gateway/providers/opencode-go/models`);
  assert.equal(discovery.status(), 200);
  assert.equal(upstream.at(-1).url, 'https://opencode.ai/inference/go/v1/models');
  assert.equal(upstream.at(-1).headers['user-agent'], 'wangke-model-gateway/0.1');
  await page.reload();
  await page.getByTestId('provider-summary-opencode-go').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: onboarding/settings, grouped key accounts, floating save/retry on desktop and mobile, paginated discovery, credential safety, completion retry, 404 recovery, concurrent conflicts, deletion, legacy field repair and skip');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(os.tmpdir(), 'opencode/cloud-models-failure.png') });
    console.error(await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
