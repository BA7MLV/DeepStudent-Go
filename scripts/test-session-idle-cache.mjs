import assert from 'node:assert/strict';
import { idleSessionVictims, sessionPayloadBytes, IDLE_SESSION_BYTES, IDLE_SESSION_LIMIT } from '../apps/web/src/client/session-cache.ts';

const entries = Array.from({ length: 100 }, (_, id) => ({ id, bytes: 1024, used: id, protected: false }));
assert.deepEqual(idleSessionVictims(entries), entries.slice(0, 100 - IDLE_SESSION_LIMIT).map(entry => entry.id));
const protectedWork = entries.map(entry => ({ ...entry, protected: entry.id < 80 }));
assert.deepEqual(idleSessionVictims(protectedWork), entries.slice(80, 94).map(entry => entry.id), 'active work and pending drafts never become cache victims');
const large = [{ id: 1, bytes: IDLE_SESSION_BYTES + 1, used: 3, protected: false }, { id: 2, bytes: 128, used: 4, protected: false }];
assert.deepEqual(idleSessionVictims(large), [1], 'a single oversized cached window is evicted');
assert.deepEqual(idleSessionVictims(large.map(entry => ({ ...entry, protected: true }))), [], 'budget never silently discards user intent');
assert.deepEqual(idleSessionVictims([{ id: 1, bytes: 2, used: 9, protected: false }, { id: 2, bytes: 2, used: 2, protected: false }], { count: 1, bytes: 99 }), [2], 'selection recency, not numerical session id, decides LRU');
const shared = { content: '图片公式😀'.repeat(1000), attachments: [{ serverId: 'original', previewServerId: 'preview' }] };
const bytes = sessionPayloadBytes(shared);
assert.ok(bytes > shared.content.length * 2);
assert.equal(sessionPayloadBytes(shared), bytes);
assert.ok(sessionPayloadBytes({ rows: [shared, shared] }) >= bytes * 2, 'alias accounting is conservative');
const cyclic = {}; cyclic.self = cyclic;
assert.ok(Number.isFinite(sessionPayloadBytes(cyclic)));
console.log(`PASS idle session LRU, ${IDLE_SESSION_LIMIT} idle windows, ${IDLE_SESSION_BYTES} estimated payload bytes, protected work and immutable payload accounting`);
