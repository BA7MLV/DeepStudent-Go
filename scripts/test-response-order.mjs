import assert from 'node:assert/strict';
import { beginResponseSegment, nextResponseRound, rebaseResponseSegments, responseTimeline } from '../apps/web/src/utils/responseOrder.ts';
import { layoutWidgets, widgetReference } from '../apps/web/src/harness/widgetLayout.ts';
import { splitAssistantContent } from '../apps/web/src/utils/streamingHtml.ts';

const source = '  已输出的文字\n';
assert.ok(nextResponseRound(source).startsWith(source), 'rounds retain the exact rendered prefix');
assert.equal(nextResponseRound(nextResponseRound(source)), nextResponseRound(source), 'empty rounds do not grow blank space');
let segments = beginResponseSegment([], '', '', []);
assert.equal(beginResponseSegment(segments, '\n\n', '思考', []), segments, 'whitespace alone cannot split a process group');
segments = beginResponseSegment(segments, source, '先分析', []);
assert.equal(segments[1].contentOffset, source.length, 'later reasoning starts after delivered content');
const changed = source.replace('文字', '一段更长的文字');
assert.equal(rebaseResponseSegments(segments, source, changed)[1].contentOffset, changed.length, 'editing shifts later process anchors');
assert.equal(rebaseResponseSegments(segments, source, changed)[0].contentOffset, 0);

const ref = widgetReference('stable-id');
const content = `题目\n\n${ref}\n\n讲解\n\n${ref}\n\n<section>下一题</section>`;
const result = layoutWidgets(content, [{ ref: 'stable-id', html: '<div>交互</div>' }]);
assert.equal(result.markdown.length, content.length, 'deduplication preserves timeline offsets');
assert.equal(result.markdown.indexOf('<section>'), content.indexOf('<section>'), 'later HTML retains its render identity');
assert.equal(splitAssistantContent(result.markdown).filter(block => block.kind === 'widget' && block.source.trim()).length, 1);
assert.deepEqual(result.unplaced, []);

const tools = [{ id: 'first', reasoningOffset: 2 }, { id: 'second', reasoningOffset: 5 }];
const ordered = responseTimeline('说明😀\n\n结论', '先想再想了', tools, [
  { contentOffset: 0, reasoningOffset: 0, toolOffset: 0 },
  { contentOffset: 6, reasoningOffset: 2, toolOffset: 1 },
]);
assert.deepEqual(ordered.map(part => part.content), ['说明😀\n\n', '结论']);
assert.deepEqual(ordered.map(part => part.reasoning), ['先想', '再想了']);
assert.equal(ordered[1].tools[0].reasoningOffset, 3);
assert.deepEqual(ordered.flatMap(part => part.tools).map(tool => tool.id), ['first', 'second']);
for (const anchors of [undefined, [], [{ contentOffset: 1, reasoningOffset: 0, toolOffset: 0 }],
  [{ contentOffset: -1, reasoningOffset: 0, toolOffset: 0 }],
  [{ contentOffset: 0, reasoningOffset: 0, toolOffset: 0 }, { contentOffset: 999, reasoningOffset: 0, toolOffset: 0 }]]) {
  const legacy = responseTimeline(content, '思考', tools, anchors);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].content, content, 'invalid/legacy anchors never lose a prefix');
}
console.log('PASS: append-only rounds, ordered process anchors, local-edit rebasing and stable widget deduplication.');
