import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionJournalModel } from '../packages/client-core/src/session.ts';

const row = (id, content = `row-${id}`, sessionId = 1) => ({ id, sessionId, createdAt: id, role: 'assistant', content, data: {} });
const page = (rows, hasOlder = false, id = 1) => ({ session: { id }, rows, hasOlder, tasks: [] });
const baseline = (model, cursor, rows, hasOlder) => {
  model.apply({ type: 'baseline', cursor, ...page([], hasOlder) });
  model.apply({ type: 'rows', cursor, rows });
  const value = model.apply({ type: 'ready', cursor }); model.commit(cursor); return value;
};
const events = (model, changes) => {
  const baseCursor = model.cursor, cursor = baseCursor + changes.length;
  const value = model.apply({ type: 'events', baseCursor, cursor, events: changes.map((change, index) => ({ cursor: baseCursor + index + 1, ...change })), session: { id: 1 }, tasks: [] });
  model.commit(cursor); return value;
};
function delayedPage(model, response) {
  const fence = model.beginPage();
  let deliver;
  const result = new Promise(resolve => { deliver = resolve; }).then(() => model.prepend(response, fence));
  return { deliver, result };
}

test('delayed page cannot resurrect an unseen deletion; live edits/reinsertions win', async () => {
  const model = new SessionJournalModel(1);
  baseline(model, 10, [row(41)], true);
  const request = delayedPage(model, page([row(12), row(40)]));
  events(model, [{ rowId: 12, row: null }, { rowId: 40, row: row(40, 'live') }]);
  request.deliver(); const merged = await request.result;
  assert.deepEqual(merged.rows.map(row => row.id), [40, 41]);
  assert.equal(merged.rows[0].content, 'live');
  assert.equal(merged.hasOlder, false);
  const next = delayedPage(model, page([row(12)], true));
  events(model, [{ rowId: 12, row: null }, { rowId: 12, row: row(12, 'reinserted') }]);
  next.deliver(); const reinserted = await next.result;
  assert.equal(reinserted.rows[0].content, 'reinserted');
  assert.equal(reinserted.hasOlder, false, 'an exhausted frontier never regresses within one baseline');
});

test('full gap baseline invalidates old page rows and hasOlder in either direction', async () => {
  for (const staleHasOlder of [true, false]) {
    const model = new SessionJournalModel(1);
    baseline(model, 10, [row(41)], true);
    const request = delayedPage(model, page([row(12)], staleHasOlder));
    model.apply({ type: 'resync-required', cursor: 11, reason: 'journal-gap' });
    assert.equal(model.beginPage(), undefined, 'no page can bind to an incomplete rebuild');
    const full = baseline(model, 11, Array.from({ length: 65 }, (_, n) => row(100 + n)), false);
    request.deliver(); assert.equal(await request.result, undefined);
    assert.equal(full.rows.length, 65, 'full repair is never clipped to the initial window');
    const accepted = model.prepend(page([], true), model.beginPage());
    assert.equal(accepted.hasOlder, false);
    assert.deepEqual(accepted.rows, full.rows);
  }
});

test('reconnect, reset baseline, observation release and model identity reject old promises', async () => {
  for (const invalidate of [model => model.reconnect(), model => model.invalidatePages(), model => baseline(model, 11, [row(42)], true)]) {
    const model = new SessionJournalModel(1);
    baseline(model, 10, [row(41)], true);
    const request = delayedPage(model, page([row(12)]));
    invalidate(model);
    request.deliver(); assert.equal(await request.result, undefined);
  }
  const old = new SessionJournalModel(1), replacement = new SessionJournalModel(1);
  baseline(old, 10, [row(41)], true); baseline(replacement, 10, [row(42)], true);
  assert.equal(replacement.prepend(page([row(12)]), old.beginPage()), undefined);
});

test('only latest request may publish pagination metadata; a response is consumed once', async () => {
  const model = new SessionJournalModel(1);
  baseline(model, 10, [row(41)], true);
  const older = delayedPage(model, page([row(12)], true));
  const latest = delayedPage(model, page([row(40)], false));
  latest.deliver(); const merged = await latest.result;
  older.deliver(); assert.equal(await older.result, undefined);
  assert.deepEqual(merged.rows.map(row => row.id), [40, 41]);
  assert.equal(merged.hasOlder, false);
  const fence = model.beginPage();
  assert.ok(model.prepend(page([], false), fence));
  assert.equal(model.prepend(page([row(12)], true), fence), undefined);
});

test('pagination validates session identity and duplicate rows before mutation', () => {
  const model = new SessionJournalModel(1);
  baseline(model, 10, [row(41)], true);
  for (const invalid of [page([row(12, 'foreign', 2)]), page([], false, 2), page([row(12), row(12)])]) {
    const fence = model.beginPage();
    assert.throws(() => model.prepend(invalid, fence), /protocol_session_row_identity/);
    assert.deepEqual(model.prepend(page([], true), fence).rows.map(row => row.id), [41]);
  }
});

test('failed request cleanup cannot cancel a newer page and invalid journal gaps fence pending IO', async () => {
  const model = new SessionJournalModel(1);
  baseline(model, 10, [row(41)], true);
  const failed = model.beginPage();
  model.endPage(failed);
  assert.equal(model.prepend(page([row(12)]), failed), undefined);
  const newer = model.beginPage();
  model.endPage(failed);
  assert.ok(model.prepend(page([row(40)], true), newer));
  const pending = delayedPage(model, page([row(12)]));
  assert.throws(() => model.apply({ type: 'events', baseCursor: 9, cursor: 10, events: [{ cursor: 10, rowId: 40, row: null }], session: { id: 1 }, tasks: [] }), /journal_gap/);
  pending.deliver(); assert.equal(await pending.result, undefined);
  assert.equal(model.beginPage(), undefined);
});
