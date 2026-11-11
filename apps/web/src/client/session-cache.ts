/** Conservative retained-payload estimate, not a JS heap measurement. Memoized
 * immutable subtrees keep idle-cache accounting off the streaming hot path. */
const sizes = new WeakMap<object, number>();
export function sessionPayloadBytes(value: unknown, ancestors = new Set<object>()): number {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 8;
  const cached = sizes.get(value);
  if (cached !== undefined) return cached;
  if (ancestors.has(value)) return 0;
  ancestors.add(value);
  let size = 32;
  for (const [key, item] of Object.entries(value)) size += key.length * 2 + sessionPayloadBytes(item, ancestors);
  ancestors.delete(value);
  sizes.set(value, size);
  return size;
}

export const IDLE_SESSION_LIMIT = 6;
export const IDLE_SESSION_BYTES = 16 * 1024 * 1024;
/** Protected work (active view, task, draft, page, uncertain submission) is not
 * cache. It can exceed the idle budget but is never dropped to meet a number. */
export function idleSessionVictims(entries: { id: number; bytes: number; used: number; protected: boolean }[],
  limits = { count: IDLE_SESSION_LIMIT, bytes: IDLE_SESSION_BYTES }): number[] {
  const idle = entries.filter(entry => !entry.protected).sort((a, b) => a.used - b.used);
  let count = idle.length, bytes = idle.reduce((total, entry) => total + entry.bytes, 0);
  const victims: number[] = [];
  for (const entry of idle) {
    if (count <= limits.count && bytes <= limits.bytes) break;
    victims.push(entry.id); count--; bytes -= entry.bytes;
  }
  return victims;
}
