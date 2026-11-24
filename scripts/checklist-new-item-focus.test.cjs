// node --test scripts/checklist-new-item-focus.test.cjs
// Typing into a list's "List item" row turns the first character into a new
// item and moves the caret into it. With completed items shown below the
// list, the last visible row is a checked item: focus must go to the new row,
// or the rest of the word lands in that checked item ("Eggs" + "honeItem").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

let selection = null;
const fakeWindow = {
  getSelection: () => ({
    selectAllChildren: node => { selection = { node } },
    collapseToEnd: () => { if (selection) selection.end = true },
    removeAllRanges() {}, addRange() {}
  })
};

function load(file) {
  const exports = {};
  const decorator = () => value => value;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, {
    exports, console, window: fakeWindow, document: { body: {} },
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

// A list with "Milk" open and "Eggs" checked; the editor shows checked items
// in a Completed section below the "List item" row.
function editorWithCompletedItemShown(draftHtml) {
  const editor = Object.create(InputComponent.prototype);
  const focused = [];
  const rowEl = id => ({ dataset: { cboxId: String(id) }, focus() { focused.push(id) } });
  Object.assign(editor, {
    activeChecklistId: 'a',
    checkBoxes: [
      { id: 0, listId: 'a', data: 'Milk', done: false, indentLevel: 0 },
      { id: 1, listId: 'a', data: 'Eggs', done: true, indentLevel: 0 }
    ],
    cboxSuggestionEligibleIds: new Set(),
    inputLength: { value: {}, next() {} },
    cd: { detectChanges() {} },
    syncCboxDomIntoModel() {}, pushCboxHistorySnapshot() {}, queueAutosave() {},
    // Display order: open rows, then completed rows.
    visibleCboxInputs() {
      const open = this.checkBoxes.filter(row => !row.done), done = this.checkBoxes.filter(row => row.done)
      return [...open, ...done].map(row => rowEl(row.id))
    }
  });
  const draft = { innerHTML: draftHtml, replaceChildren() { this.innerHTML = '' } };
  Object.defineProperty(editor, 'cboxPh', { value: { nativeElement: draft } });
  return { editor, focused };
}

test('a character typed in the List item row (mobile input) focuses the new row, not the checked one', () => {
  const { editor, focused } = editorWithCompletedItemShown('P');
  editor.cboxPhInput();
  const added = editor.checkBoxes.find(row => row.data === 'P');
  assert.ok(added, 'the typed character becomes a new item');
  assert.deepEqual(focused, [added.id]);
  assert.notEqual(focused[0], 1, 'the checked "Eggs" row must not receive the caret');
});

test('a key typed in the List item row (keyboard) focuses the new row', () => {
  const { editor, focused } = editorWithCompletedItemShown('');
  editor.cboxPhKeyDown({ key: 'W', isComposing: false, keyCode: 87, preventDefault() {} });
  const added = editor.checkBoxes.find(row => row.data === 'W');
  assert.ok(added);
  assert.deepEqual(focused, [added.id]);
});

test('Enter in a filled List item row adds it and focuses the new empty row', () => {
  const { editor, focused } = editorWithCompletedItemShown('Bread');
  editor.hasMeaningfulBody = html => !!String(html || '').trim();
  editor.enterFromChecklistPlaceholder();
  const empty = editor.checkBoxes.find(row => row.data === '');
  assert.ok(editor.checkBoxes.some(row => row.data === 'Bread'));
  assert.ok(empty);
  assert.deepEqual(focused, [empty.id]);
});
