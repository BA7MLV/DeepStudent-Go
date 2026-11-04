import assert from 'node:assert/strict';
import { SessionQueueModel } from '../packages/client-core/src/session-queue.ts';

const views = new Map();
const view = id => {
  if (!views.has(id)) views.set(id, { queued: [], loading: false, loaded: true, pendingAsk: null });
  return views.get(id);
};
let sequence = 0;
const sends = [], releases = [], steers = [];
const queue = new SessionQueueModel({
  read: view,
  replace: (id, queued) => { view(id).queued = queued; },
  nextId: () => String(++sequence),
  send: async (id, item) => {
    assert.ok(!view(id).queued.includes(item), 'remove before reentrant dispatch');
    view(id).loading = true;
    queue.drain(id);
    sends.push({ id, item });
    throw new Error('uncertain_send');
  },
  steer: async (id, item) => { steers.push({ id, item }); },
  attachmentId: file => file.id,
  releaseAttachment: async file => { releases.push(file.id); if (file.id === 'failed') throw new Error('release_failed'); },
});
queue.enqueue(1, ' first ', [{ id: 'shared' }], [4]);
queue.enqueue(1, 'second', [{ id: 'shared' }]);
queue.enqueue(2, 'other');
queue.enqueue(1, '   ');
assert.equal(view(1).queued.length, 2);
const first = view(1).queued[0];
queue.remove(1, first.id);
assert.deepEqual(releases, [], 'a still-queued attachment must not be deleted');
queue.clear(1);
await Promise.resolve();
assert.deepEqual(releases, ['shared']);
assert.equal(view(2).queued.length, 1, 'clearing one session preserves another');
for (const gate of ['loading', 'loaded', 'pendingAsk']) {
  const baseline = { ...view(2) };
  view(2)[gate] = gate === 'loaded' ? false : true;
  queue.drain(2);
  assert.equal(sends.length, 0, `${gate} blocks dispatch`);
  Object.assign(view(2), baseline);
}
queue.drain(2);
await Promise.resolve();
assert.equal(sends.length, 1);
assert.equal(sends[0].id, 2);
assert.deepEqual(view(2).queued, [], 'uncertain dispatch is never silently replayed');
queue.enqueue(3, 'attachment', [{ id: 'file' }]);
const attachedId = view(3).queued[0].id;
queue.update(3, attachedId, ' ');
assert.equal(view(3).queued.length, 1, 'attachment-only edited entry remains');
await queue.sendNow(3, attachedId);
assert.equal(steers[0].id, 3);
assert.equal(steers[0].item.text, '请分析这些附件。');
assert.deepEqual(steers[0].item.attachments, [{ id: 'file' }]);
queue.enqueue(3, 'blank edit');
queue.update(3, view(3).queued[0].id, '  ');
assert.deepEqual(view(3).queued, []);
await queue.release([{ id: 'x', text: '', attachments: [{ id: 'failed' }, { id: 'failed' }, { id: 'ok' }] }]);
assert.equal(releases.filter(id => id === 'failed').length, 1);
assert.ok(releases.includes('ok'), 'one failed cleanup does not prevent other files releasing');
console.log('PASS: React-free session queue gates, session isolation, dequeue-before-dispatch, no uncertain replay and attachment ownership');
