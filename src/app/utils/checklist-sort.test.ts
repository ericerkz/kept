// node --test src/app/utils/checklist-sort.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortChecklistItems } from './checklist-sort.ts';

type Row = { data: string; done?: boolean; indentLevel?: number; listId?: string };
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

test('completed children stay with their own parents when completed rows display at the bottom', () => {
  const items: Row[] = [
    { data: 'B parent', indentLevel: 0 },
    { data: 'A child of B', indentLevel: 1, done: true },
    { data: 'A parent', indentLevel: 0 },
    { data: 'Z child of A', indentLevel: 1, done: true }
  ];
  const before = JSON.stringify(items);
  assert.deepEqual(names(sortChecklistItems(items, { text, locale: 'en', separateCompleted: true })),
    ['A parent', 'Z child of A', 'B parent', 'A child of B']);
  assert.equal(JSON.stringify(items), before);
});

test('mixed completion states sort siblings without moving children outside their subtree', () => {
  const items: Row[] = [
    { data: 'A completed parent', done: true },
    { data: 'B unchecked child', indentLevel: 1 },
    { data: 'A completed child', indentLevel: 1, done: true },
    { data: 'Z unchecked parent' },
    { data: 'Z completed child', indentLevel: 1, done: true },
    { data: 'A unchecked child', indentLevel: 1 }
  ];
  assert.deepEqual(names(sortChecklistItems(items, { text, locale: 'en', separateCompleted: true })),
    ['Z unchecked parent', 'A unchecked child', 'Z completed child', 'A completed parent', 'B unchecked child', 'A completed child']);
});

test('multiple checklists sort independently with their nesting and list identities intact', () => {
  const items: Row[] = [
    { data: 'Z first', listId: 'first' },
    { data: 'B child', listId: 'first', indentLevel: 1, done: true },
    { data: 'A first', listId: 'first' },
    { data: 'Z second', listId: 'second' },
    { data: 'A child', listId: 'second', indentLevel: 1, done: true },
    { data: 'A second', listId: 'second' }
  ];
  const sorted = sortChecklistItems(items, { text, locale: 'en', separateCompleted: true });
  assert.deepEqual(sorted, [items[2], items[0], items[1], items[5], items[3], items[4]]);
  assert.deepEqual(sorted.map(row => row.listId), ['first', 'first', 'first', 'second', 'second', 'second']);
  assert.deepEqual(sorted.map(row => row.indentLevel ?? 0), [0, 0, 1, 0, 0, 1]);
});

test('plain text is converted once per row, even for a large checklist', () => {
  const items: Row[] = Array.from({ length: 1000 }, (_, index) => ({ data: `Item ${(index * 997) % 1000}` }));
  let conversions = 0;
  const sorted = sortChecklistItems(items, { text: row => { conversions++; return row.data; }, locale: 'en' });
  assert.equal(conversions, items.length);
  assert.equal(sorted[0].data, 'Item 0'); assert.equal(sorted.at(-1)?.data, 'Item 999');
  assert.equal(new Set(sorted).size, items.length);
});
