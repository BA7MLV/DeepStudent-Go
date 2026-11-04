import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRuntime, applyRuntimePatch, reconcileRuntime } from '../packages/contracts/src/runtime-projection.ts';

test('delta round trips additions, removals, arrays, null and prototype-shaped JSON keys', () => {
  const values = [null, true, 3, 'text', [], [1, { nested: true }], {}, { nested: { a: 1 }, empty: null },
    JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":42}}')];
  for (const before of values) for (const after of values) {
    const original = structuredClone(before);
    assert.deepEqual(applyRuntimePatch(before, diffRuntime(before, after)), after);
    assert.deepEqual(before, original, 'patch never mutates a published baseline');
  }
  assert.equal({}.polluted, undefined);
});

test('unchanged branches keep identity across baseline replacement and deltas', () => {
  const previous = { entities: { first: { title: 'one' }, second: { title: 'two' } }, list: [1, 2] };
  assert.equal(reconcileRuntime(previous, structuredClone(previous)), previous);
  const after = { ...previous, entities: { ...previous.entities, first: { title: 'changed' } } };
  const result = applyRuntimePatch(previous, diffRuntime(previous, after));
  assert.equal(result.entities.second, previous.entities.second);
  assert.equal(result.list, previous.list);
  assert.notEqual(result.entities.first, previous.entities.first);
});

test('malformed paths are protocol errors, not implicit object creation', () => {
  assert.throws(() => applyRuntimePatch({}, [{ path: ['missing', 'key'], value: 1 }]), /protocol_missing_patch_parent/);
  assert.throws(() => applyRuntimePatch(1, [{ path: ['key'], value: 1 }]), /protocol_invalid_patch_path/);
  assert.throws(() => applyRuntimePatch({}, [{ path: [], remove: true }]), /protocol_invalid_root_patch/);
});
