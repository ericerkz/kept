// node --test scripts/checklist-indent-sections.test.cjs
// With "move checked items to the bottom" on, checked rows are shown in a
// Completed section but stay where they were in the stored list. Indenting
// and checking a parent must follow the rows as shown: "Bread" indented under
// "Milk" is Milk's child even though the checked "Eggs" is stored between
// them, so checking Milk checks Bread too.
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
    exports, console, window: {}, document: {},
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

function editor(moveCompletedToBottom) {
  const e = Object.create(InputComponent.prototype);
  Object.assign(e, {
    activeChecklistId: 'default',
    checkBoxes: [
      { id: 0, data: 'Milk', done: false, indentLevel: 0 },
      { id: 1, data: 'Eggs', done: true, indentLevel: 0 },
      { id: 2, data: 'Bread', done: false, indentLevel: 0 }
    ],
    noteToEdit: {},
    preferences: { value: { moveCompletedChecklistItemsToBottom: moveCompletedToBottom } },
    cd: { detectChanges() {} },
    syncCboxDomIntoModel() {}, pushCboxHistorySnapshot() {}, queueAutosave() {}
  });
  return e;
}
const row = (e, data) => e.checkBoxes.find(cb => cb.data === data);

test('Tab nests a row under the row shown above it, skipping the hidden checked row', () => {
  const e = editor(true);
  assert.equal(e.adjustCboxIndentLevel(2, 1), true);
  assert.equal(row(e, 'Bread').indentLevel, 1);
});

test('checking the parent checks the child shown under it', () => {
  const e = editor(true);
  e.adjustCboxIndentLevel(2, 1);
  e.toggleCboxDoneWithChildren(0);
  assert.equal(row(e, 'Milk').done, true);
  assert.equal(row(e, 'Bread').done, true, 'Bread was shown nested under Milk');
});

test('without the Completed section, stored order still decides', () => {
  const e = editor(false);
  e.adjustCboxIndentLevel(2, 1);
  e.toggleCboxDoneWithChildren(0);
  assert.equal(row(e, 'Milk').done, true);
  assert.equal(row(e, 'Bread').done, false, 'Bread is shown under Eggs here, not under Milk');
});
