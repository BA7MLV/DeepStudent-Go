import { createClientRuntime, type ClientRuntime } from '@wangke/client-core';
import { API_BASE_URL } from '../api/base';

let active: { account: string; epoch: number; ready: Promise<ClientRuntime>; runtime?: ClientRuntime } | undefined;
let epoch = 0;

/** Browser carrier only. Workers retain their separate capability client. */
export function serverRuntime(account: string): Promise<ClientRuntime> {
  if (!account) return Promise.reject(new Error('client_unauthenticated'));
  if (active?.account === account) return active.ready;
  disposeServerRuntime();
  const current = epoch;
  const base = new URL(`${API_BASE_URL || location.origin}/`, location.href).href;
  const ready = createClientRuntime({ server: base, account, scope: 'account' }, {
    interactions: 'answer', location,
    transport: {
      streamBaseUrl: base,
      fetch: (url, init) => fetch(typeof url === 'string' ? new URL(url.replace(/^\//, ''), base) : url, { ...init, credentials: 'include' }),
    },
  }).then(async runtime => {
    if (current !== epoch) { await runtime.dispose(); throw new Error('client_account_changed'); }
    if (active?.epoch === current) active.runtime = runtime;
    return runtime;
  });
  active = { account, epoch: current, ready };
  void ready.catch(() => { if (active?.epoch === current) active = undefined; });
  return ready;
}

/** Reject late cache/callback work even after its task stream has completed. */
export function isCurrentServerRuntime(runtime: ClientRuntime): boolean {
  return active?.runtime === runtime;
}

export function disposeServerRuntime() {
  epoch++;
  const old = active; active = undefined;
  if (old?.runtime) void old.runtime.dispose().catch(() => {});
  else void old?.ready.then(runtime => runtime.dispose()).catch(() => {});
}

if (typeof window !== 'undefined') {
  window.addEventListener('wangke:bot-session-ended', disposeServerRuntime);
  window.addEventListener('pagehide', disposeServerRuntime);
}
import.meta.hot?.dispose(disposeServerRuntime);
