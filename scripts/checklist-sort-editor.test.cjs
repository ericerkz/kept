const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file) {
  const exports = {};
  const decorator = () => value => value;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console, require(id) {
    if (id === '@angular/core') return { Component: decorator, ViewChild: () => () => {}, Input: () => () => {}, HostBinding: () => () => {}, HostListener: () => () => {} };
    if (id.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
    if (/\/(checklist-sort|checkbox-indent|checklist-placement)$/.test(id)) return load(`src/app/utils/${id.split('/').at(-1)}.ts`);
    return {};
  } });
  return exports;
}
const { InputComponent } = load('src/app/components/input/input.component.ts');
function fixture(rows, separateCompleted = true) {
  const editor = Object.create(InputComponent.prototype);
  const elements = rows.map(row => ({ getAttribute: () => String(row.id), innerHTML: row.data }));
  const noteBody = '<p>Before</p><div class="kept-checklist-anchor kept-list-first"></div><p>Between</p><div class="kept-checklist-anchor kept-list-second"></div><p>After</p>';
  Object.assign(editor, {
    checkBoxes: rows, noteToEdit: { checkBoxes: rows, noteBody }, isCbox: { value: true },
    preferences: { value: { moveCompletedChecklistItemsToBottom: separateCompleted } },
    cboxHistory: [], cboxHistoryIndex: -1, renders: 0, saves: 0, closed: 0,
    cd: { detectChanges() { editor.renders++; } }, inputLength: { value: {}, next() {} },
    Shared: { closeTooltip() { editor.closed++; } }, queueAutosave() { editor.saves++; },
    notePlainText: value => String(value).replace(/<[^>]*>/g, ''),
    noteContainer: { nativeElement: { querySelectorAll: () => elements } }
  });
  editor.resetCboxHistory();
  return { editor, elements, noteBody };
}

test('sort preserves unsaved rich text, manual order undo/redo and text between separate checklists', () => {
  const { editor, elements, noteBody } = fixture([
    { id: 0, listId: 'first', data: 'Z parent', indentLevel: 0 },
    { id: 1, listId: 'first', data: 'A child', indentLevel: 1, done: true },
    { id: 2, listId: 'first', data: 'B parent', indentLevel: 0 },
    { id: 3, listId: 'second', data: 'Z second', indentLevel: 0 },
    { id: 4, listId: 'second', data: 'A second', indentLevel: 0 }
  ]);
  elements[0].innerHTML = '<b>Z parent typed just now</b>';
  editor.sortCboxItems({});
  assert.deepEqual(Array.from(editor.checkBoxes, row => row.id), [2, 0, 1, 4, 3]);
  assert.equal(editor.checkBoxes[1].data, '<b>Z parent typed just now</b>');
  assert.equal(editor.checkBoxes[2].indentLevel, 1); assert.equal(editor.checkBoxes[2].done, true);
  assert.equal(editor.noteToEdit.noteBody, noteBody); assert.equal(editor.closed, 1); assert.equal(editor.saves, 1);
  editor.stepCboxHistory('undo');
  assert.deepEqual(Array.from(editor.checkBoxes, row => row.id), [0, 1, 2, 3, 4]);
  assert.equal(editor.checkBoxes[0].data, '<b>Z parent typed just now</b>');
  editor.stepCboxHistory('redo');
  assert.deepEqual(Array.from(editor.checkBoxes, row => row.id), [2, 0, 1, 4, 3]);
  const saved = editor.currentCheckBoxesForSave(false);
  assert.deepEqual(Array.from(saved, row => row.id), [2, 0, 1, 4, 3]);
  assert.equal(saved[1].data, '<b>Z parent typed just now</b>');
});

test('the action appears only when at least one checklist has multiple rows', () => {
  const { editor } = fixture([{ id: 0, listId: 'first', data: 'One' }, { id: 1, listId: 'second', data: 'Two' }]);
  assert.equal(editor.canSortCboxItems(), false);
  editor.checkBoxes.push({ id: 2, listId: 'first', data: 'Another' }); assert.equal(editor.canSortCboxItems(), true);
  editor.isCbox.value = false; assert.equal(editor.canSortCboxItems(), false);
});

test('already-sorted rows do not add history or autosave and dragging still sets a manual order', () => {
  const { editor } = fixture([{ id: 0, data: 'A' }, { id: 1, data: 'B' }]);
  editor.sortCboxItems({}); assert.equal(editor.saves, 0); assert.equal(editor.cboxHistory.length, 1);
  // Sorting is a single edit; subsequent manual ordering is not automatically re-sorted.
  editor.checkBoxes.reverse();
  assert.deepEqual(Array.from(editor.currentCheckBoxesForSave(false), row => row.id), [1, 0]);
});
