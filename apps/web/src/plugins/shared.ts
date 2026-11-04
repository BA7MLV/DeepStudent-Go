import { readRendererPluginAsset } from '../client/plugin-renderer-assets';

/** One in-flight read per account session/resource, never cache mutations. */
const reads = new Map<string, { promise: Promise<unknown>; at: number }>();
let epoch = 0;
export function pluginRead<T>(path: string, ttl = 1000): Promise<T> {
  const previous = reads.get(path);
  if (previous && Date.now() - previous.at < ttl) return previous.promise as Promise<T>;
  const before = epoch;
  const entry = { at: Date.now(), promise: readRendererPluginAsset<T>(path).then(value => { if (before !== epoch) throw new Error('plugin_session_changed'); return value; }) };
  reads.set(path, entry);
  void entry.promise.catch(() => { if (reads.get(path) === entry) reads.delete(path); });
  return entry.promise;
}
export function clearPluginReads() { reads.clear(); }
window.addEventListener('wangke:bot-session-ended', () => {
  epoch++; reads.clear();
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('plugin-draft:')) sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
});
