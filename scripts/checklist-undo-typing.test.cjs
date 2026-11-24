// node --test scripts/checklist-undo-typing.test.cjs
// Undo of a checklist change (deleting, checking or indenting a row) goes back
// one step in the checklist history. Text typed into rows since the previous
// change must survive that Undo: type " TYPED" into one row, delete another
// row, press Undo -> the deleted row is back and " TYPED" is still there.
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
  }).outputText, {
    exports, console, window: {}, document: {}, Date,
    require(id) {
      if (id === '@angular/core') return { Component: decorator, ViewChild: () => () => {}, Input: () => () => {}, HostBinding: () => () => {}, HostListener: () => () => {} };
      if (id.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
      if (/\/(checklist-sort|checkbox-indent|checklist-placement)$/.test(id)) return load(`src/app/utils/${id.split('/').at(-1)}.ts`);
      return {};
    }
  });
  return exports;
}
const { InputComponent } = load('src/app/components/input/input.component.ts');

// Rows as stored, plus their editable elements (what the user sees and types into).
function fixture(rows) {
  const editor = Object.create(InputComponent.prototype);
  let elements = rows.map(row => ({ getAttribute: () => String(row.id), innerHTML: row.data }));
  Object.assign(editor, {
    checkBoxes: rows, noteToEdit: { checkBoxes: rows }, isCbox: { value: true },
    preferences: { value: { moveCompletedChecklistItemsToBottom: true } },
    cboxSuggestionEligibleIds: new Set(), cboxSuggestionDraftValues: new Map(), dismissedCboxSuggestionIds: new Set(),
    inputLength: { value: {}, next() {} },
    // Re-render: one element per stored row, showing its stored text.
    cd: { detectChanges() { elements = editor.checkBoxes.map(row => ({ getAttribute: () => String(row.id), innerHTML: row.data })) } },
    queueAutosave() {},
    noteContainer: { nativeElement: { querySelectorAll: () => elements } }
  });
  editor.resetCboxHistory();
  const type = (id, html) => {
    elements.find(el => el.getAttribute() === String(id)).innerHTML = html;
    editor.onCboxInput(id);
  };
  const shown = () => elements.map(el => el.innerHTML);
  return { editor, type, shown };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 3));

test('Undo of a delete keeps text typed before it', async () => {
  const { editor, type, shown } = fixture([
    { id: 0, data: 'Buy organic milk', done: false, indentLevel: 0 },
    { id: 1, data: 'Second', done: false, indentLevel: 0 }
  ]);
  await tick();
  type(0, 'Buy organic milk TYPED');
  await tick();
  editor.cboxTools(1).remove();
  editor.cd.detectChanges();
  assert.deepEqual(shown(), ['Buy organic milk TYPED']);

  editor.stepCboxHistory('undo');
  editor.cd.detectChanges();
  assert.deepEqual(shown(), ['Buy organic milk TYPED', 'Second'], 'the row is back and the typing is kept');

  editor.stepCboxHistory('redo');
  editor.cd.detectChanges();
  assert.deepEqual(shown(), ['Buy organic milk TYPED']);
});

test('Undo of checking a row keeps text typed before it', async () => {
  const { editor, type } = fixture([
    { id: 0, data: 'Milk', done: false, indentLevel: 0 },
    { id: 1, data: 'Eggs', done: false, indentLevel: 0 }
  ]);
  await tick();
  type(1, 'Eggs x12');
  await tick();
  editor.cboxTools(0).check();
  editor.cd.detectChanges();
  editor.stepCboxHistory('undo');
  assert.deepEqual(editor.checkBoxes.map(row => [row.data, row.done]), [['Milk', false], ['Eggs x12', false]]);
});

test('a change with no typing before it adds a single Undo step', async () => {
  const { editor } = fixture([
    { id: 0, data: 'Milk', done: false, indentLevel: 0 },
    { id: 1, data: 'Eggs', done: false, indentLevel: 0 }
  ]);
  editor.cboxTools(1).remove();
  assert.equal(editor.cboxHistory.length, 2);
  editor.stepCboxHistory('undo');
  assert.deepEqual(editor.checkBoxes.map(row => row.data), ['Milk', 'Eggs']);
});
