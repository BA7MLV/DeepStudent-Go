import { create } from 'zustand';

/**
 * 封面刷新令牌。
 *
 * 存在的理由：封面是**异步补上**的派生资源（导入后几百毫秒到几秒），而资料库列表的
 * 数据来自一次性的 `reload()`。没有这个令牌，新导入的卡片会一直停在占位图上，
 * 直到用户切走再回来 —— 而那时封面其实早就生成好了。
 *
 * 刻意做得极轻：只递增一个数字，`useThumb` 订阅它，+1 就重查自己那一张
 * （`covers.get(id)` 是主键查询，一屏几十张也就几十次 O(1)）。
 * **不去调整个列表的 reload** —— 那要把 `videos` 整表读进内存，正是拆出独立
 * `covers` 表要躲开的开销。
 */
interface CoverStore {
  revision: number;
  bump: () => void;
}

interface CoverUrlEntry {
  createdAt: number;
  url: string;
  refs: number;
  lastUsed: number;
}

/**
 * Keep object URLs stable while a user moves between library folders.
 *
 * `URL.createObjectURL` is cheap, but every new URL makes the browser treat
 * the same Blob as a new image resource. Folder navigation unmounts cards, so
 * without this small cache returning to a parent folder flashes/reloads every
 * cover. The bounded cache keeps this from retaining an unbounded number of
 * large cover Blobs for the lifetime of the tab.
 */
const MAX_CACHED_COVERS = 128;
const coverUrls = new Map<string, CoverUrlEntry>();

function pruneCoverUrls() {
  if (coverUrls.size <= MAX_CACHED_COVERS) return;
  for (const [videoId, entry] of [...coverUrls.entries()]
    .filter(([, value]) => value.refs === 0)
    .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)) {
    if (coverUrls.size <= MAX_CACHED_COVERS) break;
    URL.revokeObjectURL(entry.url);
    coverUrls.delete(videoId);
  }
}

export function cachedCoverUrl(videoId: string, createdAt: number): string | undefined {
  const entry = coverUrls.get(videoId);
  if (!entry || entry.createdAt !== createdAt) return undefined;
  entry.lastUsed = Date.now();
  return entry.url;
}

export function createCachedCoverUrl(videoId: string, createdAt: number, blob: Blob): string {
  const previous = coverUrls.get(videoId);
  if (previous) URL.revokeObjectURL(previous.url);
  const entry = { createdAt, url: URL.createObjectURL(blob), refs: 0, lastUsed: Date.now() };
  coverUrls.set(videoId, entry);
  pruneCoverUrls();
  return entry.url;
}

export function retainCoverUrl(videoId: string) {
  const entry = coverUrls.get(videoId);
  if (entry) { entry.refs += 1; entry.lastUsed = Date.now(); }
}

export function releaseCoverUrl(videoId: string) {
  const entry = coverUrls.get(videoId);
  if (entry) { entry.refs = Math.max(0, entry.refs - 1); entry.lastUsed = Date.now(); }
}

/** Called when the underlying cover is deleted, rather than merely hidden. */
export function invalidateCoverUrl(videoId: string) {
  const entry = coverUrls.get(videoId);
  if (!entry) return;
  URL.revokeObjectURL(entry.url);
  coverUrls.delete(videoId);
}

export const useCoverStore = create<CoverStore>()((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

/** 订阅刷新令牌（只取数字，避免消费者因 store 里其它字段变化而重渲染） */
export function useCoverRevision(): number {
  return useCoverStore((s) => s.revision);
}
