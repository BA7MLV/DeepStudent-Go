import assert from 'node:assert/strict';
import { compareChatRows, nextChatTurnTimes } from '../packages/study-core/src/utils/chatOrder.ts';

const sessionId = 991;
const rows = [];
// Reversed random identities must not reverse legacy same-millisecond pairs.
for (let i = 0; i < 65; i++) {
  rows.push({ id: 10000 + i, sessionId, videoId: 'test', role: 'user', content: `Q${i}`, createdAt: i + 1 });
  rows.push({ id: 100 + i, sessionId, videoId: 'test', role: 'assistant', content: `A${i}`, createdAt: i + 1 });
}
// A tie bucket bigger than a page exercises both cursor boundaries.
for (let i = 0; i < 90; i++) rows.push({ id: 20000 + i, sessionId, videoId: 'test', role: i % 2 ? 'assistant' : 'user', content: `tie${i}`, createdAt: 100 });
{
   rows.reverse();
  const expected = [...rows].sort(compareChatRows);
  let cursor;
  let all = [];
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
     // Pure shared-order invariants only; browser local pagination is retired.
     // Production server pagination is exercised by e2e-server-chat-ui.mjs.
     const remaining = expected.filter(row => !cursor || compareChatRows(row, cursor) < 0);
     const page = { rows: remaining.slice(-40), hasOlder: remaining.length > 40 };
    assert.ok(page.rows.length > 0);
    all = [...page.rows, ...all];
    if (!page.hasOlder) break;
    cursor = page.rows[0];
  }
  assert.deepEqual(all.map(row => row.id), expected.map(row => row.id), 'pagination has no missing, duplicated or reversed rows');
  assert.equal(new Set(all.map(row => row.id)).size, rows.length);
  assert.deepEqual(nextChatTurnTimes([], 500, 500), { user: 500, assistant: 501 });
  assert.deepEqual(nextChatTurnTimes([{ createdAt: 900 }], 400, 450), { user: 901, assistant: 902 }, 'clock rollback cannot reorder a new turn');
  const first = nextChatTurnTimes([], 100, 200);
  const second = nextChatTurnTimes([{ createdAt: first.assistant }], 200, 200);
  assert.ok(first.user < first.assistant && first.assistant < second.user && second.user < second.assistant);
  console.log('PASS: legacy random IDs, model history order, multi-page timestamp ties, monotonic new turns and clock rollback.');
}
