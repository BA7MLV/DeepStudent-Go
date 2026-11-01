import type { MessageDto } from '@wangke/contracts';

export const sameMessage = (a: MessageDto, b: MessageDto) => a === b || a.id === b.id && a.seq === b.seq && a.content === b.content && a.kind === b.kind && a.role === b.role && a.createdAt === b.createdAt && a.clientNonce === b.clientNonce && a.replyTo === b.replyTo;

/** O(n+m) identity merge, preserving unchanged messages and optimistic nonce keys. */
export function mergeMessages(current: MessageDto[], incoming: MessageDto[]): MessageDto[] {
  if (!incoming.length) return current;
  const ids = new Map(current.map(message => [message.id, message]));
  const nonces = new Map(current.filter(message => message.clientNonce).map(message => [message.clientNonce, message]));
  if (incoming.every((message, index) => message.seq > (index ? incoming[index - 1].seq : current.at(-1)?.seq ?? -1))
    && !incoming.some(message => ids.has(message.id) || message.clientNonce && nonces.has(message.clientNonce))) return current.concat(incoming);
  let changed = false;
  for (const message of incoming) {
    const previous = ids.get(message.id) ?? (message.clientNonce ? nonces.get(message.clientNonce) : undefined);
    if (previous && sameMessage(previous, message)) continue;
    if (previous && previous.id !== message.id) ids.delete(previous.id);
    ids.set(message.id, message); changed = true;
    if (message.clientNonce) nonces.set(message.clientNonce, message);
  }
  if (!changed) return current;
  return [...ids.values()].sort((a, b) => a.seq - b.seq);
}

export function mergeById<T extends { id: string; status?: string }>(current: T[] = [], incoming: T[] = []): T[] {
  if (!incoming.length) return current;
  const map = new Map(current.map(item => [item.id, item]));
  let changed = false;
  for (const item of incoming) {
    const previous = map.get(item.id);
    // Question/approval resolution is irreversible. A slow page or POST must
    // never turn a card already resolved by synchronization back into pending.
    if (previous?.status && previous.status !== 'pending' && item.status === 'pending') continue;
    if (previous && JSON.stringify(previous) === JSON.stringify(item)) continue;
    map.set(item.id, item); changed = true;
  }
  return changed ? [...map.values()] : current;
}
