import assert from 'node:assert/strict';
import test from 'node:test';
import { cropPixels, rotateCrop, rotationDimensions } from '../apps/web/src/chat/cropImage.ts';

test('percent crop maps to original pixels, not the displayed thumbnail', () => {
  assert.deepEqual(cropPixels(4000, 3000, { x: 25, y: 10, width: 50, height: 60 }), { x: 1000, y: 300, width: 2000, height: 1800 });
  assert.deepEqual(cropPixels(101, 79, { x: 0, y: 0, width: 100, height: 100 }), { x: 0, y: 0, width: 101, height: 79 });
});

test('rounding and out-of-bounds coordinates cannot read outside the source', () => {
  assert.deepEqual(cropPixels(100, 80, { x: 95, y: 90, width: 50, height: 50 }), { x: 95, y: 72, width: 5, height: 8 });
  assert.deepEqual(cropPixels(1, 1, { x: 100, y: 100, width: .01, height: .01 }), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(cropPixels(100, 80, { x: -5, y: -5, width: 10, height: 10 }), { x: 0, y: 0, width: 10, height: 8 });
});

test('empty, non-finite and invalid crops fail explicitly', () => {
  const full = { x: 0, y: 0, width: 100, height: 100 };
  for (const [width, height, crop] of [[0, 1, full], [1, 0, full], [Infinity, 1, full],
    [1, 1, { ...full, x: NaN }], [1, 1, { ...full, width: 0 }], [1, 1, { ...full, height: -1 }]]) {
    assert.throws(() => cropPixels(width, height, crop), /裁切/);
  }
});

test('quarter turns swap dimensions and keep the selected source content', () => {
  assert.deepEqual(rotationDimensions(4000, 3000, 1), { width: 3000, height: 4000 });
  assert.deepEqual(rotationDimensions(4000, 3000, -1), { width: 3000, height: 4000 });
  assert.deepEqual(rotationDimensions(4000, 3000, 2), { width: 4000, height: 3000 });
  const crop = { unit: '%', x: 10, y: 20, width: 30, height: 40 };
  assert.deepEqual(rotateCrop(crop, 1), { unit: '%', x: 40, y: 10, width: 40, height: 30 });
  assert.deepEqual(rotateCrop(rotateCrop(crop, 1), -1), crop);
  assert.deepEqual(Array.from({ length: 4 }).reduce(current => rotateCrop(current, 1), crop), crop);
});
