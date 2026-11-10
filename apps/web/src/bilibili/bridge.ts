export const BILI_SCRIPT_URL = '/wangke-bili-bridge.user.js';
export const BILI_FILE_LIMIT = 512 * 1024 * 1024;

interface BridgeResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface BiliBridge {
  version: string;
  fetch(url: string, init: {
    method: string; headers: Record<string, string>; body?: ArrayBuffer;
    signal?: AbortSignal; maxBytes: number;
    onProgress?: (loaded: number, total: number) => void;
  }): Promise<BridgeResponse>;
}
declare global { interface Window { __wangkeBiliBridge?: BiliBridge } }

export function hasBiliBridge(): boolean {
  const bridge = window.__wangkeBiliBridge;
  return !!bridge && Number(bridge.version.split('.')[0]) >= 3 && typeof bridge.fetch === 'function';
}

/** Never fall back to the server: that would silently change the network/IP. */
export function biliLocalRequest(signal?: AbortSignal, onProgress?: (loaded: number, total: number) => void, maxBytes = 4 * 1024 * 1024): typeof fetch {
  return async (input, init) => {
    if (!hasBiliBridge()) throw new Error(biliText('installRequired'));
    const activeSignal = signal ?? init?.signal ?? undefined;
    activeSignal?.throwIfAborted();
    const body = init?.body;
    if (body != null && !(body instanceof ArrayBuffer)) throw new Error(biliText('requestFormat'));
    const result = await window.__wangkeBiliBridge!.fetch(String(input), {
      method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)),
      ...(body ? { body } : {}), signal: activeSignal, maxBytes, onProgress,
    });
    activeSignal?.throwIfAborted();
    // Clone across the userscript sandbox's realm before constructing a Response.
    const bytes = ArrayBuffer.prototype.slice.call(await result.arrayBuffer(), 0) as ArrayBuffer;
    if (bytes.byteLength > maxBytes) throw new Error(biliText('responseLimit'));
    return new Response(bytes, { status: result.status, headers: result.headers });
  };
}
import { biliText } from './text';
