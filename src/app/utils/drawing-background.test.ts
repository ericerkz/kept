// node --test src/app/utils/drawing-background.test.ts
// Reopening a drawing only removes a white page from old flattened exports.
// Current drawings are transparent, and white strokes in them must be kept.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawingHasTransparency } from './drawing-background.ts';

const px = (...pixels: number[][]) => Uint8ClampedArray.from(pixels.flat());

test('a transparent drawing with white ink is recognised as transparent', () => {
  const white = [255, 255, 255, 255], empty = [0, 0, 0, 0];
  assert.equal(drawingHasTransparency(px(empty, white, empty)), true);
});

test('an old export flattened onto white has no transparent pixel', () => {
  const white = [255, 255, 255, 255], black = [0, 0, 0, 255];
  assert.equal(drawingHasTransparency(px(white, black, white)), false);
});

test('anti-aliased stroke edges count as transparency', () => {
  assert.equal(drawingHasTransparency(px([0, 0, 0, 255], [0, 0, 0, 128])), true);
});
