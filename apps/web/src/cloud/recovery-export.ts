/** Lossless JSON transport for recovery archives, including nested attachments.
 * It never uploads a Blob or executes the original operation. */
export async function encodeRecoveryValue(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    return { $blob: btoa(binary), encoding: 'base64', size: value.size, type: value.type,
      ...('name' in value ? { name: value.name } : {}) };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeRecoveryValue));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value)
    .map(async ([key, item]) => [key, await encodeRecoveryValue(item)])));
  return value;
}
