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
  assert.ok(completion.includes("await flushCloud();"), 'completion keeps the projection refresh until per-kind effects exist as a protocol');
});

test('session revision in ChatPanel drains only that session entity', () => {
  const source = read('apps/web/src/components/ChatPanel.tsx');
  const revise = source.slice(source.indexOf('const updateMcpServerIds'), source.indexOf('const updateSkillIds'));
  assert.ok(revise.includes("drainLearning([`session:${activeId}`])"), 'session revision drains exactly its entity');
  assert.ok(!/\bflushCloud\(\)/.test(revise), 'session revision must not run the global records cycle');
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
