import assert from 'node:assert/strict';
import { normalizeWidgetState, widgetFollowUp } from '../apps/web/src/harness/widgetState.ts';
import { buildWidgetDocument } from '../apps/web/src/harness/widgetRuntime.ts';
import { layoutWidgets, messageWidgets, widgetReference } from '../apps/web/src/harness/widgetLayout.ts';
import { execFileSync } from 'node:child_process';

const state = { modelContent: { a: -2, step: 1 }, privateContent: { panel: 'PRIVATE_UI_ONLY' } };
assert.deepEqual(normalizeWidgetState({ modelContent: 0 }), { modelContent: 0, privateContent: null });
assert.deepEqual(normalizeWidgetState({}), { modelContent: null, privateContent: null });
const copy = normalizeWidgetState(state);
copy.modelContent.a = 7;
assert.equal(state.modelContent.a, -2, 'snapshots are detached');
const cyclic = {}; cyclic.self = cyclic;
for (const invalid of [null, [], 1, { rowId: 1 }, { modelContent: undefined }, { modelContent: NaN },
  { modelContent: Infinity }, { modelContent: new Date() }, { modelContent: () => 1 }, { modelContent: cyclic },
  { privateContent: '中'.repeat(6000) }, { modelContent: Array.from({ length: 10000 }, () => 1) },
  { modelContent: new Array(3) }]) {
  assert.throws(() => normalizeWidgetState(invalid));
}
const overhead = JSON.stringify({ modelContent: '', privateContent: null }).length;
assert.equal(normalizeWidgetState({ modelContent: 'x'.repeat(16384 - overhead) }).modelContent.length, 16384 - overhead);
assert.throws(() => normalizeWidgetState({ modelContent: 'x'.repeat(16385 - overhead) }), /16 KiB/);
let deep = 1;
for (let i = 0; i < 20; i++) deep = { child: deep };
assert.throws(() => normalizeWidgetState({ modelContent: deep }), /嵌套/);
const sent = widgetFollowUp('解释当前情况', state);
assert.ok(sent.includes('"a":-2') && sent.includes('不可信数据'));
assert.ok(!sent.includes('PRIVATE_UI_ONLY') && !sent.includes('privateContent'));
assert.equal(widgetFollowUp('  解释  ', null), '解释');
assert.throws(() => widgetFollowUp('x'.repeat(2001), state));
const injected = '</script><script>window.stolen=1</script>';
const doc = await buildWidgetDocument({ html: '<p>safe</p>' }, { state: { modelContent: injected, privateContent: null }, persistent: true });
assert.ok(!doc.includes(injected), 'saved JSON cannot terminate bootstrap scripts');
assert.ok(doc.includes("connect-src 'none'") && !doc.includes('allow-same-origin'));

const payload = { html: '<p>explore</p>' };

const first = { id: 'first', ref: 'first-ref', html: '<p>same source</p>' };
const second = { id: 'second', ref: 'second-ref', html: first.html };
const both = [first, second];
assert.deepEqual(messageWidgets({ widget: second, widgets: both }), both, 'legacy alias does not duplicate a visual');
assert.deepEqual(messageWidgets({ widget: payload }), [payload]);
const inline = `Before\n\n${widgetReference(first.ref)}\n\nBetween\n\n${widgetReference(second.ref)}\n\nAfter`;
assert.deepEqual(layoutWidgets(inline, both).unplaced, []);
assert.deepEqual(layoutWidgets(widgetReference(second.ref), both).unplaced, [first]);
assert.deepEqual(layoutWidgets('````text\n' + widgetReference(first.ref) + '\n````', both).unplaced, both, 'code examples are not live references');
assert.deepEqual(layoutWidgets(widgetReference('other-message'), both).unplaced, both, 'unknown refs cannot read other messages');
assert.equal(layoutWidgets(`${inline}\n\n${widgetReference(first.ref)}`, both).markdown.split(first.ref).length, 2, 'duplicate references render only once');
// Retired coverage mapping: browser snapshot writes -> actual native executor
// save-before-receipt/finalization/state-preservation/deleted-owner assertions.
// Client state commands, sibling edits and stale handles -> protocol browser test.
for (const script of ['test-server-widgets.mjs', 'e2e-widget-protocol.mjs']) {
  execFileSync(process.execPath, ['--import', 'tsx', new URL(script, import.meta.url).pathname], { stdio: 'inherit' });
}
console.log('PASS widget JSON/layout/bootstrap invariants + server snapshot safety + production state command/DOM coverage.');
