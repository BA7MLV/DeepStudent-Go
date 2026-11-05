import type { PluginCatalog } from '../plugins/catalog';
import { cloud } from '../cloud/state';
import { callPluginAction } from './plugins';
import { accountLifetime } from './account-lifecycle';

/** Explicit application command seams, not capabilities handed to plugins. */
export async function readRendererPluginCatalog(): Promise<PluginCatalog> {
  if (!cloud.enabled || !cloud.userId) throw new Error('client_unauthenticated');
  const lifetime = accountLifetime(cloud.userId);
  const { serverRuntime, isCurrentServerRuntime } = await import('./bootstrap');
  lifetime.assertCurrent();
  const runtime = await serverRuntime(lifetime.account);
  const value = (await runtime.read({ kind: 'catalog' })).value;
  if (!isCurrentServerRuntime(runtime)) throw new Error('plugin_session_changed');
  return value as unknown as PluginCatalog;
}
export async function saveRendererPluginLayout(content: string, expected: string, revision: number) {
  if (!cloud.enabled || !cloud.userId) throw new Error('client_unauthenticated');
  const lifetime = accountLifetime(cloud.userId);
  const { serverRuntime, isCurrentServerRuntime } = await import('./bootstrap');
  lifetime.assertCurrent();
  const runtime = await serverRuntime(lifetime.account);
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
