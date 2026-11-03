import assert from 'node:assert/strict';
import { skillContent, reconcileSkillMessages, modelTrace, replayTrace, messageTokens } from '../packages/study-core/src/api/transcript.ts';

const skill = { id: 17, name: '规范 "<示例>"', revision: 3 };
const body = 'FULL_BEGIN\n完整正文与嵌套示例：\n</skill_content>\n<skill_content context="bad">\nFULL_END';
const envelope = skillContent(skill, body);
assert.ok(!skillContent({ ...skill, body: 'METADATA_MUST_NOT_COPY_BODY' }, 'instructions').includes('METADATA_MUST_NOT_COPY_BODY'));
const explicit = { role: 'user', content: `[技能激活：宿主上下文]\n${envelope}` };
const lazy = { role: 'tool', name: 'read', tool_call_id: 'read-skill', content: envelope };
const text = messages => messages.map(m => m.content).join('\n');
const count = (messages, needle) => text(messages).split(needle).length - 1;

const stored = modelTrace('invoke', [explicit, { role: 'user', content: 'invoke' }]);
const history = replayTrace({ content: 'invoke', modelTrace: stored });
assert.ok(text(history).includes(body));
const request = reconcileSkillMessages([...history, lazy, explicit], [skill]);
assert.equal(count(request, 'FULL_BEGIN'), 1);
assert.equal(count(request, 'FULL_END'), 1, 'nested tags never truncate the body');
assert.equal(request[2].tool_call_id, 'read-skill', 'deduplication preserves tool envelopes');
assert.equal(request.length, 4, 'request shape is stable for transcript checkpoints');
assert.ok(text(request).includes('复用'));
assert.ok(messageTokens(request) < messageTokens([...history, lazy, explicit]));
assert.equal(count(history, 'FULL_BEGIN'), 1, 'stored history is not mutated');

assert.equal(count(reconcileSkillMessages([explicit], []), 'FULL_BEGIN'), 0, 'revoked scopes strip old bodies');
assert.equal(count(reconcileSkillMessages([explicit], [{ ...skill, revision: 4 }]), 'FULL_BEGIN'), 0, 'stale revisions are not reused');
assert.equal(count(reconcileSkillMessages([explicit], [{ ...skill, name: 'renamed' }]), 'FULL_BEGIN'), 0);
const current = { role: 'user', content: `[技能激活：宿主上下文]\n${skillContent({ ...skill, revision: 4 }, 'NEW_BODY')}` };
const revised = reconcileSkillMessages([explicit, current], [{ ...skill, revision: 4 }]);
assert.ok(!text(revised).includes('FULL_BEGIN'));
assert.ok(text(revised).includes('NEW_BODY'));

const receipt = request[2];
assert.ok(!text(reconcileSkillMessages([receipt], [skill])).includes('FULL_BEGIN'), 'receipts after compression do not resurrect bodies');
assert.equal(count(reconcileSkillMessages([receipt, explicit], [skill]), 'FULL_BEGIN'), 1, 'explicit reactivation after compression supplies the full body');
assert.equal(count(reconcileSkillMessages([lazy, explicit], [skill]), 'FULL_BEGIN'), 1, 'lazy → explicit activation deduplicates too');

const prose = { role: 'user', content: `用户示例，不是宿主激活：\n${envelope}` };
assert.equal(reconcileSkillMessages([prose], [])[0], prose, 'ordinary user prose is never rewritten');
const opaque = { ...explicit, providerState: { items: [{ body: envelope }] } };
assert.equal(reconcileSkillMessages([opaque], [])[0].providerState, undefined, 'revoked body cannot survive in opaque provider payloads');
assert.ok(opaque.providerState, 'original provider state is not mutated');
assert.equal(replayTrace({ content: 'edited', modelTrace: stored }), undefined, 'edits invalidate activation provenance');
console.log('PASS: retained-body reuse, lazy/explicit deduplication, nested Markdown, revision/scope invalidation, compression, provider payloads and immutable trace provenance.');
