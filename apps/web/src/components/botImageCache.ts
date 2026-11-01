// Only authenticated remote images are cached. Draft Files remain component-owned.
type Entry = { refs: number; bytes: number; used: number; objectUrl?: string; controller: AbortController; promise: Promise<string> };
const entries = new Map<string, Entry>();
const ttl = 60_000;
let timer: ReturnType<typeof setTimeout> | undefined;

function dispose(entry: Entry) {
  entry.controller.abort();
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
}
function prune() {
  clearTimeout(timer); timer = undefined;
  let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [key, entry] of [...entries].sort(([, a], [, b]) => a.used - b.used)) {
    if (entry.refs || entries.size <= 64 && bytes <= 32 * 1024 * 1024 && Date.now() - entry.used < ttl) continue;
    entries.delete(key); bytes -= entry.bytes; dispose(entry);
  }
  const unused = [...entries.values()].filter(entry => !entry.refs);
  if (unused.length) timer = setTimeout(prune, Math.max(1, Math.min(...unused.map(entry => ttl - (Date.now() - entry.used)))));
}

export function clearBotImageCache() {
  clearTimeout(timer); timer = undefined;
  for (const entry of entries.values()) dispose(entry);
  entries.clear();
}
export function invalidateBotImage(url: string) {
  const entry = entries.get(url);
  if (!entry) return;
  entries.delete(url);
  if (!entry.refs) dispose(entry);
}
if (typeof window !== 'undefined') window.addEventListener('wangke:bot-session-ended', clearBotImageCache);

export function acquireBotImage(url: string) {
  let entry = entries.get(url);
  if (!entry) {
    const controller = new AbortController();
    entry = { refs: 0, bytes: 0, used: Date.now(), controller, promise: Promise.resolve('') };
    const item = entry;
    item.promise = (async () => {
      const response = await fetch(url, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error('file_not_found');
      const blob = await response.blob();
      if (controller.signal.aborted) throw new Error('image_cancelled');
      item.bytes = blob.size; item.objectUrl = URL.createObjectURL(blob);
      prune();
      return item.objectUrl;
    })().catch(error => { if (entries.get(url) === item) entries.delete(url); throw error; });
    entries.set(url, item);
  }
  const item = entry;
  item.refs++; item.used = Date.now();
  let released = false;
  return {
    promise: item.promise,
    release() {
      if (released) return;
      released = true; item.refs--; item.used = Date.now();
      if (!item.refs && entries.get(url) !== item) dispose(item);
      else if (!item.refs && !item.objectUrl) { entries.delete(url); dispose(item); }
      prune();
    },
  };
}
