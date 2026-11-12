/** Source-shape regression: task admission and session revision must keep the
 * precise push drains instead of regressing to a global flushCloud cycle.
 * This is a structural assertion, not a runtime execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('task admission pushes local pending writes without a global records pull', () => {
  const source = read('apps/web/src/cloud/tasks.ts');
  const admission = source.slice(source.indexOf('export async function submitCloudTask'), source.indexOf('const command = { operationId, kind, resource'));
  assert.ok(admission.includes('await flushPreferences();'), 'admission must flush preferences');
  assert.ok(admission.includes('await drainLearning();'), 'admission must drain the learning journal');
  assert.ok(!/\bflushCloud\(\)/.test(admission), 'admission must not run the global records cycle');
  const completion = source.slice(source.indexOf('if (completed.kind ==='));
   assert.ok(completion.includes('await refreshTaskScope(terminal)'), 'completion keeps an explicit bounded fallback for missing/overflow receipts');
   assert.ok(!completion.includes('await flushCloud();'), 'missing effects never authorize an account mirror');
   assert.ok(completion.includes('terminal.effects !== undefined') && completion.includes('reconcileTaskEffects(terminal.effects, after.epoch)'),
    'completion must reconcile the terminal effects receipt exactly when the task carries one');
   assert.ok(completion.includes('terminal.effects.length && !'), 'an empty proven receipt must skip projection downloads');
   assert.ok(source.includes('admissionEpoch === after.epoch') && source.includes('before.epoch !== after.epoch'), 'effects require generation evidence and a terminal read epoch barrier');
   assert.ok(source.includes("refreshRecordScope('chats', sessionId!)") && source.includes('for (const table of scopes['), 'fallback reads explicit session/course collections');
   assert.ok(source.includes('task_scope_refresh_unavailable:'), 'unsupported fallback must fail visibly, not silently skip');
});

test('session revision in ChatPanel drains only that session entity', () => {
  const source = read('apps/web/src/components/ChatPanel.tsx');
  const revise = source.slice(source.indexOf('const updateMcpServerIds'), source.indexOf('const updateSkillIds'));
  assert.ok(revise.includes("drainLearning([`session:${activeId}`])"), 'session revision drains exactly its entity');
  assert.ok(!/\bflushCloud\(\)/.test(revise), 'session revision must not run the global records cycle');
});

test('model settings save pushes the preferences journal, not a global records cycle', () => {
  const source = read('apps/web/src/cloud/Models.tsx');
  const save = source.slice(source.indexOf('const saved = await cloudRequest<CloudConfig>'), source.indexOf('setSavedPreferences(JSON.stringify(cloudModelPreferences(draft)));'));
  assert.ok(save.includes('flushPreferences();'), 'model preferences flush through their own journal');
  assert.ok(!/\bflushCloud\(\)/.test(source), 'model settings must not run the global records cycle');
});

test('material readers consume the bounded snapshot, not the business mirror', () => {
  for (const file of ['apps/web/src/components/MdReader.tsx', 'apps/web/src/components/DocxReader.tsx', 'apps/web/src/components/HtmlReader.tsx']) {
    const source = read(file);
    assert.ok(source.includes('loadMaterialBlocksSnapshot('), `${file} must read via the bounded snapshot`);
    assert.ok(!/db\.materialBlocks/.test(source), `${file} must not query the business mirror directly`);
  }
  const chat = read('apps/web/src/components/ChatPanel.tsx');
  assert.ok(chat.includes('materialBlocksSnapshotExist('), 'chat retrieval readiness uses the bounded existence check');
  assert.ok(!/db\.materialBlocks/.test(chat), 'chat must not query materialBlocks from the mirror directly');
});
