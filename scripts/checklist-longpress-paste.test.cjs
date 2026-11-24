// node --test scripts/checklist-longpress-paste.test.cjs
// Touching a checklist row that is not focused turns editing off until the
// touch ends, so scrolling a list does not open the keyboard. A touch held in
// place is a long-press: the row must be editable again before the browser's
// long-press fires, or Android's menu offers only Copy/Share and no Paste.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const fakeDocument = { activeElement: null };
function load(file) {
  const exports = {};
  const decorator = () => value => value;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, {
    exports, console, window: {}, document: fakeDocument, setTimeout, clearTimeout,
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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });

function row() {
  const editor = Object.create(InputComponent.prototype);
  const el = { contentEditable: 'true', blur() {} };
  return { editor, el };
}

test('a held touch makes the row editable again before the long-press menu', async () => {
  const { editor, el } = row();
  editor.cboxTextTouchStart(touch(100, 100), 3, el);
  assert.equal(el.contentEditable, 'false', 'editing is off while the touch may be a scroll');
  await wait(400);
  assert.equal(el.contentEditable, 'true', 'editable again during the hold, so the menu can offer Paste');
  // The long-press menu cancels the touch; editing stays on.
  editor.cboxTextTouchCancel(3, el);
  assert.equal(el.contentEditable, 'true');
});

test('a touch that moves (a scroll) keeps editing off until it ends', async () => {
  const { editor, el } = row();
  editor.cboxTextTouchStart(touch(100, 100), 3, el);
  editor.cboxTextTouchMove(touch(100, 160), 3, el);
  await wait(400);
  assert.equal(el.contentEditable, 'false', 'no keyboard while scrolling');
  editor.cboxTextTouchCancel(3, el);
  assert.equal(el.contentEditable, 'true');
});

test('a quick tap is unchanged: editing comes back when the touch ends', async () => {
  const { editor, el } = row();
  editor.cboxTextTouchStart(touch(100, 100), 3, el);
  editor.cboxTextTouchCancel(3, el);
  assert.equal(el.contentEditable, 'true');
  await wait(400);
  assert.equal(el.contentEditable, 'true', 'a finished touch leaves no timer behind');
});
