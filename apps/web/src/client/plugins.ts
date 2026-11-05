import type { RuntimeJson, RuntimeRead } from '@wangke/contracts/client-runtime';
import { cloud } from '../cloud/state';
import { accountLifetime } from './account-lifecycle';

async function pluginRuntime(account: string, current = () => true) {
  if (!cloud.enabled || !account) throw new Error('client_unauthenticated');
  const lifetime = accountLifetime(account);
  const { serverRuntime, isCurrentServerRuntime } = await import('./bootstrap');
  lifetime.assertCurrent();
  if (!current()) throw new Error('plugin_observation_cancelled');
  if (cloud.userId !== account) throw new Error('plugin_session_changed');
  const runtime = await serverRuntime(account);
  lifetime.assertCurrent();
  return { runtime, isCurrentServerRuntime, lifetime };
}

export type PluginIdentity = { pluginId: string; instanceId: string; revision?: number };
export type PluginQuery = { key: string; method: string; args: Record<string, unknown> };
type Query = Extract<RuntimeRead, { kind: 'plugin' }>;
const query = (identity: PluginIdentity, method: string, args: Record<string, unknown>): Query => {
  if (identity.revision === undefined) throw new Error('plugin_revision_required');
  return { kind: 'plugin', ...identity, revision: identity.revision, method,
    // The generated codec is authoritative and rejects non-JSON arguments.
    args: args as Record<string, RuntimeJson> };
};

/** Unary calls use declared Host metadata, never method-name heuristics. */
export async function callPlugin(identity: PluginIdentity, method: string, args: Record<string, unknown> = {}) {
  const { runtime, isCurrentServerRuntime, lifetime } = await pluginRuntime(cloud.userId);
  const catalog = runtime.catalog().getSnapshot().data ?? (await runtime.read({ kind: 'catalog' })).value;
  lifetime.assertCurrent();
  const services = (catalog as { services: { id: string; access: 'read' | 'write' }[] }).services;
  const definition = services.find(service => service.id === method);
  if (!definition) throw new Error('plugin_method_unavailable');
  const request = query(identity, method, args);
  const result = definition.access === 'read'
    ? (await runtime.read(request)).value
    : await runtime.command({ ...identity, revision: request.revision, method, args: request.args, operationId: crypto.randomUUID() });
  if (!isCurrentServerRuntime(runtime)) throw new Error('plugin_session_changed');
  return result;
}

/** Named contributions use the same durable command receipts as method calls. */
export async function callPluginAction(identity: PluginIdentity, actionId: string, args: Record<string, unknown>, operationId = crypto.randomUUID()) {
  const { runtime, isCurrentServerRuntime } = await pluginRuntime(cloud.userId);
  const request = query(identity, actionId, args);
  const result = await runtime.command({ ...identity, revision: request.revision, method: actionId, args: request.args, target: 'action', operationId });
  if (!isCurrentServerRuntime(runtime)) throw new Error('plugin_session_changed');
  return result;
}

/** Every update executes PluginService.resolve/invoke, including tasks.get scope authorization. */
export function observePlugin(identity: PluginIdentity, method: string, args: Record<string, unknown>,
  listener: (value: unknown) => void, failed: (error: Error) => void) {
  if (identity.revision === undefined) { failed(new Error('plugin_revision_required')); return () => {}; }
  return observeRequest(query(identity, method, args), listener, failed);
}

function observeRequest(request: Extract<RuntimeRead, { kind: 'plugin' | 'pluginQueries' }>,
  listener: (value: unknown) => void, failed: (error: Error) => void) {
  let active = true;
  let off: (() => void) | undefined, release: (() => void) | undefined;
  let detach: (() => void) | undefined;
  const stop = () => { if (!active) return; active = false; detach?.(); off?.(); release?.(); };
  void pluginRuntime(cloud.userId, () => active).then(({ runtime, isCurrentServerRuntime, lifetime }) => {
    if (!active || !isCurrentServerRuntime(runtime)) return;
    detach = lifetime.own(stop);
    const model = runtime.plugin(request);
    let previous: RuntimeJson | undefined;
    const update = () => {
      if (!active || !isCurrentServerRuntime(runtime)) return;
      const snapshot = model.getSnapshot();
      if (snapshot.status === 'error') failed(new Error(snapshot.error));
      else if (snapshot.status === 'ready' && snapshot.data !== undefined && snapshot.data !== previous) {
        previous = snapshot.data; listener(snapshot.data);
      }
    };
    off = model.subscribe(update); release = model.acquire(); update();
  }).catch(error => { if (active) failed(error instanceof Error ? error : new Error(String(error))); });
  return stop;
}
