import { createClientRuntime, type ClientRuntime } from '@wangke/client-core';
import { API_BASE_URL } from '../api/base';
import { cloud } from '../cloud/state';
import { accountLifecycle, accountLifetime, invalidateAccountLifetime, type AccountLifetime } from './account-lifecycle';

let active: { lifetime: AccountLifetime; ready: Promise<ClientRuntime>; runtime?: ClientRuntime } | undefined;

/** Browser account resources share the runtime's terminal invalidation point. */
export function onServerRuntimeDisposed(dispose: () => void): () => void {
  return accountLifecycle.onDisposed(dispose);
}

/** Browser carrier only. Workers retain their separate capability client. */
export function serverRuntime(account: string): Promise<ClientRuntime> {
  if (!account) return Promise.reject(new Error('client_unauthenticated'));
  if (!cloud.enabled || cloud.userId !== account) return Promise.reject(new Error('client_account_changed'));
  const lifetime = accountLifetime(account);
  if (active?.lifetime === lifetime) return active.ready;
  const base = new URL(`${API_BASE_URL || location.origin}/`, location.href).href;
  const ready = createClientRuntime({ server: base, account, scope: 'account' }, {
    interactions: 'answer', location,
    transport: {
      streamBaseUrl: base,
      fetch: (url, init) => fetch(typeof url === 'string' ? new URL(url.replace(/^\//, ''), base) : url, { ...init, credentials: 'include' }),
    },
  }).then(async runtime => {
    lifetime.own(() => runtime.dispose());
    lifetime.assertCurrent();
    if (active?.lifetime === lifetime) active.runtime = runtime;
    return runtime;
  });
  active = { lifetime, ready };
  lifetime.own(() => { if (active?.lifetime === lifetime) active = undefined; });
  void ready.catch(() => { if (lifetime.current()) invalidateAccountLifetime(); });
  return ready;
}

/** Reject late cache/callback work even after its task stream has completed. */
export function isCurrentServerRuntime(runtime: ClientRuntime): boolean {
  return active?.runtime === runtime && active.lifetime.current();
}

export function disposeServerRuntime() {
  invalidateAccountLifetime();
}

if (typeof window !== 'undefined') {
  window.addEventListener('wangke:bot-session-ended', disposeServerRuntime);
  window.addEventListener('pagehide', disposeServerRuntime);
}
import.meta.hot?.dispose(disposeServerRuntime);
