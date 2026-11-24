// node --test src/app/utils/checklist-paste.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checklistItemHtml, parseChecklistLines } from './checklist-paste.ts';

test('parses dash, star, plus, and unicode bullet characters', () => {
  const dash = parseChecklistLines('- Milk\n- Eggs\n- Bread');
  assert.equal(dash.isList, true);
  assert.deepEqual(dash.items, [
    { text: 'Milk', done: false, indentLevel: 0 },
    { text: 'Eggs', done: false, indentLevel: 0 },
    { text: 'Bread', done: false, indentLevel: 0 }
  ]);

  const star = parseChecklistLines('* Apples\n* Bananas');
  assert.equal(star.isList, true);
  assert.deepEqual(star.items.map(i => i.text), ['Apples', 'Bananas']);

  const bullets = parseChecklistLines('+ Plus\n• Bullet\n◦ White bullet\n▪ Square\n‣ Triangular\n· Middle dot');
  assert.equal(bullets.isList, true);
  assert.deepEqual(bullets.items.map(i => i.text), [
    'Plus', 'Bullet', 'White bullet', 'Square', 'Triangular', 'Middle dot'
  ]);
});

test('parses numbered and lettered list markers like 1., 1), 10., a., a)', () => {
  const numbered = parseChecklistLines('1. First\n2) Second\n10. Tenth\na. Lower dot\nb) Lower paren');
  assert.equal(numbered.isList, true);
  assert.deepEqual(numbered.items, [
    { text: 'First', done: false, indentLevel: 0 },
    { text: 'Second', done: false, indentLevel: 0 },
    { text: 'Tenth', done: false, indentLevel: 0 },
    { text: 'Lower dot', done: false, indentLevel: 0 },
    { text: 'Lower paren', done: false, indentLevel: 0 }
  ]);
});

test('parses markdown tasks, bare brackets, and Keep checkbox glyphs', () => {
  const md = parseChecklistLines('- [ ] Unchecked task\n- [x] Checked lower\n* [X] Checked upper');
  assert.equal(md.isList, true);
  assert.deepEqual(md.items, [
    { text: 'Unchecked task', done: false, indentLevel: 0 },
    { text: 'Checked lower', done: true, indentLevel: 0 },
    { text: 'Checked upper', done: true, indentLevel: 0 }
  ]);

  const bare = parseChecklistLines('[ ] Bare space\n[] Bare empty\n[x] Bare done\n[X] Bare done upper');
  assert.equal(bare.isList, true);
  assert.deepEqual(bare.items, [
    { text: 'Bare space', done: false, indentLevel: 0 },
    { text: 'Bare empty', done: false, indentLevel: 0 },
    { text: 'Bare done', done: true, indentLevel: 0 },
    { text: 'Bare done upper', done: true, indentLevel: 0 }
  ]);

  const glyphs = parseChecklistLines('☐ Keep open\n☑ Keep checked\n☒ Crossed box\n✓ Check\n✔ Heavy check\n✅ Emoji check');
  assert.equal(glyphs.isList, true);
  assert.deepEqual(glyphs.items, [
    { text: 'Keep open', done: false, indentLevel: 0 },
    { text: 'Keep checked', done: true, indentLevel: 0 },
    { text: 'Crossed box', done: true, indentLevel: 0 },
    { text: 'Check', done: true, indentLevel: 0 },
    { text: 'Heavy check', done: true, indentLevel: 0 },
    { text: 'Emoji check', done: true, indentLevel: 0 }
  ]);
});

test('normalizes CRLF and ignores blank or whitespace-only lines between items', () => {
  const parsed = parseChecklistLines('\r\n- First\r\n\r\n   \t  \r\n- Second\r- Third\r\n');
  assert.equal(parsed.isList, true);
  assert.deepEqual(parsed.items.map(i => i.text), ['First', 'Second', 'Third']);
});

test('computes nested indentation from spaces and tabs, relative to shallowest and clamped', () => {
  const spaces = parseChecklistLines([
    '  - Parent',
    '    - Child 1',
    '      - Grandchild',
    '        - Great-grandchild',
    '          - Clamped beyond max',
    '  - Sibling',
    '        - Orphan clamped to 1 deeper'
  ].join('\n'));
  assert.equal(spaces.isList, true);
  assert.deepEqual(spaces.items.map(i => [i.text, i.indentLevel]), [
    ['Parent', 0],
    ['Child 1', 1],
    ['Grandchild', 2],
    ['Great-grandchild', 3],
    ['Clamped beyond max', 3],
    ['Sibling', 0],
    ['Orphan clamped to 1 deeper', 1]
  ]);

  const tabs = parseChecklistLines('\t* Root\n\t\t* Nested one\n\t\t\t* Nested two');
  assert.equal(tabs.isList, true);
  assert.deepEqual(tabs.items.map(i => i.indentLevel), [0, 1, 2]);
});

test('preserves unicode and emoji text and drops lines that are only a marker', () => {
  const parsed = parseChecklistLines('- 🥛 Lait & Crème\n-\n- [ ]\n1.\n☐\n- [x] 🥚 Œufs frais 🎉');
  assert.equal(parsed.isList, true);
  assert.deepEqual(parsed.items, [
    { text: '🥛 Lait & Crème', done: false, indentLevel: 0 },
    { text: '🥚 Œufs frais 🎉', done: true, indentLevel: 0 }
  ]);

  assert.deepEqual(parseChecklistLines('-\n- [ ]\n☐'), { items: [], isList: false });
});

test('marks plain prose, single lines, and numbers in text like "2 cups flour" as isList: false', () => {
  const prose = parseChecklistLines('Remember to call the dentist\nPick up dry cleaning on Friday');
  assert.equal(prose.isList, false);
  assert.deepEqual(prose.items, [
    { text: 'Remember to call the dentist', done: false, indentLevel: 0 },
    { text: 'Pick up dry cleaning on Friday', done: false, indentLevel: 0 }
  ]);

  const single = parseChecklistLines('- Only one bullet');
  assert.equal(single.isList, false);
  assert.deepEqual(single.items, [{ text: 'Only one bullet', done: false, indentLevel: 0 }]);

  const recipe = parseChecklistLines('2 cups flour\n3 eggs\n1 tsp salt');
  assert.equal(recipe.isList, false);
  assert.deepEqual(recipe.items.map(i => i.text), ['2 cups flour', '3 eggs', '1 tsp salt']);

  const mixedMostlyMarked = parseChecklistLines('- 2 cups flour\n- 3 eggs\n1 tsp salt');
  assert.equal(mixedMostlyMarked.isList, true);
  assert.deepEqual(mixedMostlyMarked.items.map(i => i.text), ['2 cups flour', '3 eggs', '1 tsp salt']);
});

test('checklistItemHtml escapes &, <, and >', () => {
  assert.equal(checklistItemHtml('<b>Tom & Jerry > Spike</b>'), '&lt;b&gt;Tom &amp; Jerry &gt; Spike&lt;/b&gt;');
});
