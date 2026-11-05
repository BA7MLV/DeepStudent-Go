/** Canonical input identity, including attachment bytes. Run before opening IDB. */
export async function commandDigest(value: unknown): Promise<string> {
  const hash = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const canonical = async (item: unknown): Promise<unknown> => {
    if (item instanceof Blob) return { blob: await hash(await item.arrayBuffer()), size: item.size, type: item.type };
    if (Array.isArray(item)) return Promise.all(item.map(canonical));
    if (item && typeof item === 'object') return Object.fromEntries(await Promise.all(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(async ([key, value]) => [key, await canonical(value)])));
    return item;
  };
  return hash(new TextEncoder().encode(JSON.stringify(await canonical(value))));
}
