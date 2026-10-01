// node --test src/app/utils/checkbox-indent.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_INDENT_LEVEL, descendantIndexes, maxIndentLevelAt, normalizeIndentLevel } from './checkbox-indent.ts';

const rows = (...levels: number[]) => levels.map(indentLevel => ({ indentLevel }));

test('normalizeIndentLevel clamps to 0..MAX', () => {
  assert.equal(normalizeIndentLevel(undefined), 0);
  assert.equal(normalizeIndentLevel('nope'), 0);
  assert.equal(normalizeIndentLevel(-3), 0);
  assert.equal(normalizeIndentLevel(2.7), 2);
  assert.equal(normalizeIndentLevel(MAX_INDENT_LEVEL), MAX_INDENT_LEVEL);
  assert.equal(normalizeIndentLevel(99), MAX_INDENT_LEVEL);
});

test('a row may go one level deeper than the row above, up to MAX', () => {
  assert.equal(maxIndentLevelAt(rows(0, 0), 0), 0, 'first row stays at root');
  assert.equal(maxIndentLevelAt(rows(0, 0), 1), 1);
  assert.equal(maxIndentLevelAt(rows(0, 2), 1), 1, 'no jumping two levels at once');
  assert.equal(maxIndentLevelAt(rows(MAX_INDENT_LEVEL - 1, 0), 1), MAX_INDENT_LEVEL);
  assert.equal(maxIndentLevelAt(rows(MAX_INDENT_LEVEL, 0), 1), MAX_INDENT_LEVEL, 'capped at MAX');
});

test('a chain of rows can be indented down to MAX_INDENT_LEVEL and no further', () => {
  const items = rows(0, 0, 0, 0, 0);
  // Indent every row as deep as it is allowed to go, top to bottom.
  for (let i = 0; i < items.length; i++) {
    for (let step = 0; step < MAX_INDENT_LEVEL + 2; step++) {
      items[i].indentLevel = Math.min(items[i].indentLevel + 1, maxIndentLevelAt(items, i));
    }
  }
  assert.deepEqual(items.map(item => item.indentLevel), [0, 1, 2, 3, MAX_INDENT_LEVEL]);
});

test('descendantIndexes covers the contiguous deeper block', () => {
  const items = rows(0, 1, 2, 1, 0);
  assert.deepEqual(descendantIndexes(items, 0), [1, 2, 3]);
  assert.deepEqual(descendantIndexes(items, 1), [2]);
  assert.deepEqual(descendantIndexes(items, 2), []);
  assert.deepEqual(descendantIndexes(items, 4), []);
});
