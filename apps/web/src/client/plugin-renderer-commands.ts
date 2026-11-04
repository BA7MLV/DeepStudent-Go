import type { PluginCatalog } from '../plugins/catalog';
import { cloud } from '../cloud/state';
import { callPluginAction } from './plugins';

/** Explicit application command seams, not capabilities handed to plugins. */
export async function readRendererPluginCatalog(): Promise<PluginCatalog> {
  const { serverRuntime, isCurrentServerRuntime } = await import('./bootstrap');
  const runtime = await serverRuntime(cloud.userId);
  const value = (await runtime.read({ kind: 'catalog' })).value;
  if (!isCurrentServerRuntime(runtime)) throw new Error('plugin_session_changed');
  return value as unknown as PluginCatalog;
}
export async function saveRendererPluginLayout(content: string, expected: string, revision: number) {
  const { serverRuntime, isCurrentServerRuntime } = await import('./bootstrap');
  const runtime = await serverRuntime(cloud.userId);
  let value;
  try { value = await runtime.savePluginLayout({ content, expected, revision, operationId: crypto.randomUUID() }); }
  catch (error) {
    // Preserve the renderer's existing CAS retry contract while transport uses
    // the typed domain error (never infer conflicts from HTTP carrier status).
    if (error instanceof Error && 'code' in error && error.code === 'client/conflict') Object.assign(error, { status: 409 });
    throw error;
  }
  if (!isCurrentServerRuntime(runtime)) throw new Error('plugin_session_changed');
  return value;
}
export { callPluginAction as runRendererPluginAction };
