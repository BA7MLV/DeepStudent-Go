import { request } from '../api/serverClient';

/** One in-flight read per account session/resource, never cache mutations. */
const reads = new Map<string, { promise: Promise<unknown>; at: number }>();
let epoch = 0;
export function pluginRead<T>(path: string, ttl = 1000): Promise<T> {
  const previous = reads.get(path);
  if (previous && Date.now() - previous.at < ttl) return previous.promise as Promise<T>;
  const before = epoch;
  const entry = { at: Date.now(), promise: request<T>(path).then(value => { if (before !== epoch) throw new Error('plugin_session_changed'); return value; }) };
  reads.set(path, entry);
  void entry.promise.catch(() => { if (reads.get(path) === entry) reads.delete(path); });
  return entry.promise;
}
export function clearPluginReads() { reads.clear(); }
export function pluginRpc(path: string, revision: number | undefined, method: string, args: Record<string, unknown>) {
  const isRead = method.endsWith('.read') || method.endsWith('.list') || method === 'tasks.get' || method === 'practice.get' || method === 'learning.materials' || method === 'learning.results' || method === 'schedules.threads';
  const key = `${path}:${revision}:${method}:${JSON.stringify(args)}`;
  const before = epoch;
  const existing = reads.get(key);
  if (isRead && existing && Date.now() - existing.at < 1400) return existing.promise;
  const promise = request(path, { method: 'POST', body: JSON.stringify({ revision, method, args }) }).then(value => {
    if (before !== epoch) throw new Error('plugin_session_changed');
    if (!isRead) clearPluginReads();
    return value;
  });
  if (isRead) {
    const entry = { at: Date.now(), promise }; reads.set(key, entry);
    void promise.catch(() => { if (reads.get(key) === entry) reads.delete(key); });
  }
  return promise;
}

type Channel = { listeners: Set<(result: unknown) => void>; read: () => Promise<unknown>; timer?: ReturnType<typeof setTimeout>; active: boolean; last?: string; value?: unknown };
const channels = new Map<string, Channel>();
window.addEventListener('wangke:bot-session-ended', () => {
  epoch++; reads.clear();
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('plugin-draft:')) sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
  for (const c of channels.values()) { c.active = false; clearTimeout(c.timer); c.listeners.clear(); }
  channels.clear();
});
export function subscribePluginRead(key: string, read: () => Promise<unknown>, listener: (result: unknown) => void) {
  let channel = channels.get(key);
  if (!channel) {
    channel = { listeners: new Set(), read, active: true }; channels.set(key, channel);
    const c = channel;
    const poll = async () => {
      try {
        if (!document.hidden) {
          const result = await c.read(), next = JSON.stringify(result);
           if (c.active && next !== c.last) { c.last = next; c.value = result; for (const fn of c.listeners) fn(result); }
        }
      } catch { /* The invoking host reports RPC failures; transient polling is retried. */ }
      if (c.active) c.timer = setTimeout(poll, 1500);
    };
    void poll();
  }
  channel.listeners.add(listener);
  if (channel.last !== undefined) listener(channel.value);
  const c = channel;
  return () => { c.listeners.delete(listener); if (!c.listeners.size) { c.active = false; clearTimeout(c.timer); channels.delete(key); } };
}
