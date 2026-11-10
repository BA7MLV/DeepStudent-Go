// Browser regressions configure through the production server plugin tool API.
// These helpers are fixtures, not a claim that a real model followed the skill.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

export async function pluginTool(page, args) {
  return page.evaluate(async args => {
    const result = await (await import('/src/api/serverClient.ts')).request('/plugins/tool', { method: 'POST', body: JSON.stringify(args) });
    if (['configure', 'invoke', 'lifecycle'].includes(args.operation)) await (await import('/src/plugins/catalog.ts')).refreshPlugins();
    return result;
  }, args);
}
export async function editLayout(page, change) {
  const before = await pluginTool(page, { operation: 'layout' });
  const layout = JSON.parse(before.content);
  await change(layout);
  await pluginTool(page, { operation: 'configure', content: JSON.stringify(layout), expected: before.content, revision: before.revision });
  return layout;
}
export async function assertCreationHint(page) {
  await page.getByTestId('plugin-creation-hint').first().waitFor();
  assert.equal(await page.locator('.plugin-manager,[data-testid="plugin-manager-dialog"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /^(添加功能|管理挂载|添加到侧边栏|从侧边栏移除)$/ }).count(), 0);
}
// Custom host integrations opt in to the sidepanel. The stock chat page must
// stay free of a generic component launcher or development guidance.
export async function openChatPlugins(page) {
  assert.equal(await page.getByRole('button', { name: '组件', exact: true }).count(), 0);
  assert.equal(await page.locator('[data-plugin-slot="chat.sidepanel"]').count(), 0);
  await page.evaluate(async () => {
    const path = '/src/store/botPanel.ts';
    const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
    const { useBotPanel } = await import(resource?.name ?? path);
    useBotPanel.getState().setAuxiliary('plugins');
  });
  const slot = page.locator('[data-plugin-slot="chat.sidepanel"]');
  await slot.waitFor();
  assert.equal(await slot.getByTestId('plugin-creation-hint').count(), 0);
}
export async function addPlugin(page, options) {
  const catalog = await pluginTool(page, { operation: 'list' });
  const pkg = catalog.plugins.find(p => p.id === options.pluginId && p.enabled && !p.error);
  assert.ok(pkg, `available plugin ${options.pluginId}`);
  const targets = { ...pkg.views, ...pkg.contributions };
  const viewId = options.viewId ?? Object.entries(targets).find(([, v]) => v.surfaces.includes(options.surface))?.[0];
  assert.ok(viewId, `supported view for ${options.surface}`);
  const projectSelector = page.getByLabel('项目上下文', { exact: true });
  // AppSelect is now an accessible listbox trigger, not a native <select>.
  // PluginSlot persists the selected project in its router query.
  const project = await projectSelector.count() ? await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('project') ?? undefined) : undefined;
  if (project) assert.ok(catalog.scopes.projects.some(row => row.id === project), 'selected project must be server-visible');
  let scope = options.scope ? (() => { const at = options.scope.indexOf(':'); return at < 0 ? { kind: options.scope } : { kind: options.scope.slice(0, at), id: options.scope.slice(at + 1) }; })() : project ? { kind: 'project', id: project } : { kind: 'account' };
  let instanceId;
  await editLayout(page, layout => {
    let instance = options.instanceId ? layout.instances.find(i => i.id === options.instanceId && i.pluginId === options.pluginId) : undefined;
    if (options.instanceId) assert.ok(instance, 'existing content must exist');
    if (!instance && !options.newContent && options.instanceId !== '') instance = layout.instances.find(i => i.pluginId === options.pluginId && JSON.stringify(i.scope) === JSON.stringify(scope));
    if (instance) scope = instance.scope;
    else { instance = { id: crypto.randomUUID(), pluginId: options.pluginId, scope, title: options.title }; layout.instances.push(instance); }
    instanceId = instance.id;
    const placement = { id: crypto.randomUUID(), pluginId: options.pluginId, instanceId, viewId, surface: options.surface, scope, order: layout.placements.length };
    layout.placements.push(placement);
    if (options.surface === 'app.page') (layout.navigation ??= []).push({ id: crypto.randomUUID(), placementId: placement.id, title: options.title ?? instance.title ?? pkg.name, order: layout.navigation.length });
  });
  return instanceId;
}
export async function changePlugin(page, id, action) {
  const status = { '停用插件': 'disabled', '启用插件': 'enabled', '卸载（保留数据）': 'uninstalled', '重新安装并恢复': 'enabled' }[action];
  assert.ok(status);
  const before = await pluginTool(page, { operation: 'layout' });
  await pluginTool(page, { operation: 'lifecycle', pluginId: id, status, expected: before.content, revision: before.revision });
}
