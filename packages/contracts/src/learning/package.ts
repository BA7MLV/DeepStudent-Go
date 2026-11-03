import type { PluginManifest, PluginPackage } from '../plugins.js';

export function learningPackage(id: string, name: string, capabilities: PluginManifest['capabilities'], actions: NonNullable<PluginManifest['actions']>, requires?: Record<string, number>, description?: string): PluginPackage {
  return { id, source: 'builtin', path: `builtin:${id}`, revision: 1, manifest: {
    apiVersion: 2, id, name, description, version: '2.0.0', enabled: true, capabilities, requires, services: { 'learning-data': 1 },
    views: { main: { entry: 'views/main.html', surfaces: ['board.main', 'chat.sidepanel', 'reader.sidepanel', 'app.page', 'chat.message'] } },
    actions: {
      materials: { title: '选择可访问资料', service: 'learning.materials', schema: { type: 'object' } },
      results: { title: '查看任务与持久产物收据', service: 'learning.results', schema: { type: 'object' } },
      ...actions,
    },
    contributions: { open: { title: `打开${name}`, viewId: 'main', surfaces: ['chat.composer.actions', 'reader.selection.actions', 'resource.actions'] } },
  } };
}
export const learningAction = (title: string, service: string) => ({ title, service, schema: { type: 'object' } });
