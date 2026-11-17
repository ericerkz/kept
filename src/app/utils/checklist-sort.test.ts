// node --test src/app/utils/checklist-sort.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortChecklistItems } from './checklist-sort.ts';

type Row = { data: string; done?: boolean; indentLevel?: number };
const text = (row: Row) => row.data;
const names = (items: Row[]) => items.map(row => row.data);

test('sorts case-insensitively, numerically and with accents', () => {
  const items: Row[] = ['banana', 'Item 10', 'apple', 'Éclair', 'item 2', 'Cherry'].map(data => ({ data }));
  assert.deepEqual(names(sortChecklistItems(items, { text, locale: 'en' })),
    ['apple', 'banana', 'Cherry', 'Éclair', 'item 2', 'Item 10']);
});

test('nested rows stay with their parent and are sorted among siblings', () => {
  const items: Row[] = [
    { data: 'Toiletries' },
    { data: 'toothbrush', indentLevel: 1 },
    { data: 'shampoo', indentLevel: 1 },
    { data: 'Clothes' },
    { data: 'socks', indentLevel: 1 },
    { data: 'wool', indentLevel: 2 },
    { data: 'cotton', indentLevel: 2 },
    { data: 'jacket', indentLevel: 1 }
  ];
  const sorted = sortChecklistItems(items, { text, locale: 'en' });
  assert.deepEqual(names(sorted),
    ['Clothes', 'jacket', 'socks', 'cotton', 'wool', 'Toiletries', 'shampoo', 'toothbrush']);
  assert.deepEqual(sorted.map(row => row.indentLevel ?? 0), [0, 1, 1, 2, 2, 0, 1, 1]);
});

test('completed rows are sorted separately only when they are moved to the bottom', () => {
  const items: Row[] = [
    { data: 'd', done: true },
    { data: 'c' },
    { data: 'b', done: true },
    { data: 'a' }
  ];
  assert.deepEqual(names(sortChecklistItems(items, { text, locale: 'en', separateCompleted: true })), ['a', 'c', 'b', 'd']);
  assert.deepEqual(names(sortChecklistItems(items, { text, locale: 'en' })), ['a', 'b', 'c', 'd']);
});

test('empty rows go last, ties keep their order, and the input is untouched', () => {
  const items: Row[] = [{ data: '' }, { data: 'b' }, { data: 'A' }, { data: 'a' }];
  const before = JSON.stringify(items);
  const sorted = sortChecklistItems(items, { text, locale: 'en' });
  assert.deepEqual(sorted, [items[2], items[3], items[1], items[0]]);
  assert.equal(JSON.stringify(items), before);
});
