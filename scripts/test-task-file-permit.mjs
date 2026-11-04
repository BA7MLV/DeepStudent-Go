import assert from 'node:assert/strict';
import { taskFilePermit } from '../apps/api/src/realtime/task-file-permit.ts';
import { planAgentEdits } from '../apps/web/src/md-editor/edits.ts';

const source = { id: 'source', name: 'Source.pdf', folderId: 7 };
const records = { get: (_owner, _table, id) => id === 'source' ? source : null };
const input = JSON.stringify({ videoId: source.id });
const allowed = (args, operation) => taskFilePermit(records, 'owner', input,
  { kind: 'saveMarkdown', courseId: source.id, ...operation }, JSON.stringify({ tool: 'edit', arguments: { path: '/courses/current/material', ...args } }));

for (const [text, edits] of [
  ['one two', [{ old_string: 'one', new_string: 'ONE' }]],
  ['aaa', [{ old_string: 'aa', new_string: 'b' }]],
  ['a a', [{ old_string: 'a', new_string: 'b', replace_all: true }]],
  ['a a', [{ old_string: 'a', new_string: 'b', replace_all: 'false' }]],
  ['abc', [{ old_string: 'ab', new_string: '' }, { old_string: 'bc', new_string: 'x' }]],
]) {
  const plan = planAgentEdits(text, edits);
  let updated = text;
  if (plan.ok) for (const change of [...plan.changes].reverse()) updated = updated.slice(0, change.from) + change.insert + updated.slice(change.to);
  assert.equal(allowed({ edits }, { expected: text, text: updated }), plan.ok, 'exact matching agrees with the real editor planner');
}
assert.equal(allowed({ edits: [{ old_string: '^a', new_string: '$1', regex: true, flags: 'm', replace_all: true }] }, { expected: 'a\na', text: '$1\n$1' }), true, 'replacement is literal, not regex expansion');
for (const edits of [[null], [{ old_string: '(', new_string: 'x', regex: true }], [{ old_string: '^', new_string: 'x', regex: true }]]) {
  assert.equal(allowed({ edits }, { expected: 'a', text: 'x' }), false);
}
const create = { kind: 'saveMarkdown', courseId: '__course_questions__source', expected: '', text: '# Bank', createOnly: true, name: 'Source · 题库.md', folderId: 7 };
const permit = JSON.stringify({ tool: 'edit', arguments: { path: '/courses/current/questions.md', create: true, content: create.text } });
assert.equal(taskFilePermit(records, 'owner', input, create, permit), true);
for (const patch of [{ text: 'forged' }, { folderId: 8 }, { name: 'Unapproved location.md' }, { courseId: '__course_questions__other' }, { createOnly: false }]) {
  assert.equal(taskFilePermit(records, 'owner', input, { ...create, ...patch }, permit), false);
}
console.log('PASS: concrete file permit matches exact editor semantics, rejects invalid regex and binds creation identity/name/folder/content');
