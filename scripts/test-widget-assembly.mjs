import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskWidgetExecutor, SERVER_SHOW_WIDGET_TOOL } from '../apps/api/runtime/widgets.ts';
import { SHOW_WIDGET_TOOL } from '@wangke/study-core/widget-tool';

const append = (code, offset = 0, revision = 0, extra = {}) => ({ format: 'html', action: 'append', offset, revision, code, ...extra });
const complete = (offset, revision) => ({ format: 'html', action: 'complete', offset, revision, code: '' });
const discard = revision => ({ format: 'html', action: 'discard', revision, code: '' });
const read = (offset = 0, extra = {}) => ({ format: 'html', action: 'read', offset, code: '', ...extra });
const patch = (revision, edits) => ({ format: 'html', action: 'patch', revision, code: '', edits });
const noPage = () => assert.fail('not a completed page');
const snapshot = run => JSON.parse(run(read(0, { limit: 4000 }), noPage));

test('only the native tool declares assembly actions; direct format/code contract remains required', () => {
  assert.equal(SHOW_WIDGET_TOOL.function.parameters.properties.action, undefined);
  assert.deepEqual(SERVER_SHOW_WIDGET_TOOL.function.parameters.required, ['format', 'code']);
  assert.deepEqual(SERVER_SHOW_WIDGET_TOOL.function.parameters.properties.action.enum, ['append', 'read', 'patch', 'complete', 'discard']);
});

test('complete small calls assemble only in one task; final uses the existing payload validator', () => {
  const run = createTaskWidgetExecutor(), pages = [];
  const source = '<section>' + '中文😀'.repeat(10000) + '</section>';
  let offset = 0, revision = 0;
  while (offset < source.length) {
    let end = Math.min(source.length, offset + 2000);
    if (/[\uDC00-\uDFFF]/.test(source[end] ?? '')) end--;
    const receipt = JSON.parse(run(append(source.slice(offset, end), offset, revision), page => pages.push(page)));
    assert.equal(receipt.status, 'assembling-not-runnable'); assert.equal(receipt.length, end);
    assert.equal(pages.length, 0);
    offset = end;
    revision = receipt.revision;
  }
  assert.match(run(complete(offset, revision), page => pages.push(page)), /```wbw-widget/);
  assert.equal(pages.length, 1); assert.equal(pages[0].html, source);
  assert.throws(() => run(complete(offset, revision), () => {}), /revision_conflict/);
});

test('offsets, Unicode, chunk/final size bounds and invalid calls cannot mutate memory', () => {
  const run = createTaskWidgetExecutor(), accept = () => assert.fail('not a completed page');
  assert.throws(() => run(append('\ud83d'), accept), /unicode_boundary/);
  assert.throws(() => run(append('x'.repeat(6001)), accept), /chunk/);
  run(append('😀'), accept);
  assert.throws(() => run(append('duplicate', 0, 1), accept), /length=2/);
  assert.throws(() => run(append('bad', 2, 1, { extra: 1 }), accept), /invalid_widget_assembly/);
  assert.throws(() => run(append('bad', 2, 1, { libs: ['chart.js'] }), accept), /libs_only/);
  assert.equal(JSON.parse(run(append('ok', 2, 1), accept)).length, 4);
  run(discard(2), accept);
  for (let i = 0; i < 10; i++) run(append('x'.repeat(6000), i * 6000, i + 3), accept);
  assert.throws(() => run(append('!', 60000, 13), accept), /too_large/);
  run(discard(13), accept);
  assert.equal(JSON.parse(run(append('<div></div>', 0, 14), accept)).length, 11);
});

test('validation failure and delivery failure do not create a page or lose the current buffer', () => {
  const run = createTaskWidgetExecutor(), pages = [];
  run(append('<script>var x=1;'), page => pages.push(page));
  const length = '<script>var x=1;'.length;
  assert.throws(() => run(complete(length + 1, 1), page => pages.push(page)), /offset_conflict/);
  assert.throws(() => run(complete(length, 1), page => pages.push(page)), /unclosed script/);
  run(append('</script>', length, 1), page => pages.push(page));
  assert.throws(() => run(complete(length + 9, 2), () => { throw new Error('delivery cancelled'); }), /delivery cancelled/);
  run(complete(length + 9, 2), page => pages.push(page));
  const original = structuredClone(pages[0]);
  run(append('<iframe></iframe>', 0, 3), page => pages.push(page));
  assert.throws(() => run(complete(17, 4), page => pages.push(page)), /预检参数不合法/);
  assert.deepEqual(pages, [original]);
});

test('new task executors never inherit pending source; direct calls remain independent and easy', () => {
  const run = createTaskWidgetExecutor(), other = createTaskWidgetExecutor(), pages = [];
  run(append('<div>'), page => pages.push(page));
  assert.throws(() => other(complete(5, 1), page => pages.push(page)), /length=0/);
  assert.throws(() => other(append('foreign', 5, 1), page => pages.push(page)), /length=0/);
  run({ format: 'html', code: '<button>小页面</button>' }, page => pages.push(page));
  run(append('</div>', 5, 1), page => pages.push(page));
  run(complete(11, 2), page => pages.push(page));
  assert.deepEqual(pages.map(page => page.html), ['<button>小页面</button>', '<div></div>']);
});

test('exact same-base batch patches: replace, anchored insertion/deletion; no sequential semantics', () => {
  const run = createTaskWidgetExecutor();
  run(append('<div>A</div><p>B</p>'), noPage);
  run(patch(1, [{ search: '>A<', replace: '>B<' }, { search: '>B<', replace: '>C<' }]), noPage);
  assert.equal(snapshot(run).content, '<div>B</div><p>C</p>');
  run(patch(2, [{ search: '<div>', replace: '<div><b>+</b>' }, { search: '<p>C</p>', replace: '' }]), noPage);
  assert.equal(snapshot(run).content, '<div><b>+</b>B</div>');
  assert.equal(snapshot(run).revision, 3);
});

test('failed patch batches are atomic: missing, non-unique, overlap, no change and invalid fields', () => {
  const run = createTaskWidgetExecutor();
  run(append('<div>AA😀</div>'), noPage);
  const original = snapshot(run);
  for (const edits of [
    [{ search: 'AA', replace: 'BB' }, { search: 'missing', replace: 'C' }],
    [{ search: 'A', replace: 'B' }],
    [{ search: 'AA', replace: 'B' }, { search: 'AA😀', replace: 'C' }],
    [{ search: 'AA', replace: 'AA' }],
    [{ search: '', replace: '+' }],
    [{ search: 'AA', replace: 'B', position: 0 }],
    [{ search: '\ud83d', replace: 'B' }],
    [{ search: 'AA', replace: '\ude00' }],
    [{ search: 'AA', replace: 'x'.repeat(5999) }],
    Array.from({ length: 21 }, () => ({ search: 'AA', replace: 'B' })),
  ]) {
    assert.throws(() => run(patch(1, edits), noPage));
    assert.deepEqual(snapshot(run), original);
  }
});

test('every mutation requires current revision, including same-length append/complete and ABA after clears', () => {
  const run = createTaskWidgetExecutor();
  run(append('<div>A</div>'), noPage);
  const old = snapshot(run);
  run(patch(1, [{ search: 'A', replace: 'B' }]), noPage);
  for (const args of [patch(1, [{ search: 'B', replace: 'C' }]), append('!', old.length, 1), complete(old.length, 1), discard(1)]) {
    assert.throws(() => run(args, noPage), /revision_conflict/);
  }
  run(discard(2), noPage);
  assert.throws(() => run(append('<div>A</div>'), noPage), /revision_conflict/);
  run(append('<div>A</div>', 0, 3), noPage);
  run(complete(old.length, 4), () => {});
  run(append('<div>A</div>', 0, 5), noPage);
  assert.throws(() => run(complete(old.length, 4), noPage), /revision_conflict/);
  assert.throws(() => run({ ...append('! ', old.length, 6), revision: undefined }, noPage), /revision_conflict/);
  assert.equal(snapshot(run).revision, 6);
});

test('bounded reads return a consistent baseline without splitting surrogate pairs or mutating source', () => {
  const run = createTaskWidgetExecutor();
  assert.equal(snapshot(run).revision, 0);
  run(append('a😀b'), noPage);
  const first = JSON.parse(run(read(0, { limit: 2, revision: 1 }), noPage));
  assert.equal(first.content, 'a'); assert.equal(first.nextOffset, 1); assert.equal(first.revision, 1); assert.equal(first.length, 4);
  const next = JSON.parse(run(read(1, { limit: 2 }), noPage));
  assert.equal(next.content, '😀'); assert.equal(next.nextOffset, 3);
  assert.equal(JSON.parse(run(read(3), noPage)).content, 'b');
  for (const args of [read(2), read(1, { limit: 1 }), read(0, { limit: 4001 }), read(-1), read(5), read(0, { revision: 0 }), read(0, { edits: [] })]) assert.throws(() => run(args, noPage));
  assert.equal(snapshot(run).revision, 1);
});

test('60k final cap is independent of editor 120k; Unicode patch works and final failures can be repaired', () => {
  const run = createTaskWidgetExecutor(), pages = [];
  for (let i = 0; i < 10; i++) run(append(i === 0 ? 'A' + 'x'.repeat(5999) : 'x'.repeat(6000), i * 6000, i), noPage);
  assert.throws(() => run(patch(10, [{ search: 'A', replace: 'AB' }]), noPage), /too_large/);
  assert.equal(snapshot(run).revision, 10);
  run(discard(10), noPage);
  run(append('<div>😀</div><script>fetch("x")</script>', 0, 11), noPage);
  let base = snapshot(run);
  assert.throws(() => run(complete(base.length, base.revision), noPage), /预检参数不合法/);
  assert.deepEqual(snapshot(run), base);
  run(patch(base.revision, [{ search: '😀', replace: '😎' }, { search: 'fetch("x")', replace: 'var x=1;' }]), noPage);
  base = snapshot(run);
  run(complete(base.length, base.revision), page => pages.push(page));
  assert.equal(pages[0].html, '<div>😎</div><script>var x=1;</script>');
});
