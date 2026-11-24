// node --test scripts/overview-image-checklist.test.cjs
// Adding an image to a note from the notes grid (drop it on the card, or the
// card's image button) only adds the image. It used to also save
// isCbox: false, which hid every item of a checklist note.
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
    exports, console, document: {}, window: {}, setTimeout, clearTimeout,
    require(id) {
      if (id === '@angular/core') return { Component: decorator, ViewChild: () => () => {}, ViewChildren: () => () => {}, HostListener: () => () => {} };
      if (id.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
      if (id.endsWith('/note-images')) return { isNoteImageFile: file => /^image\//.test(file.type) };
      if (id === 'rxjs') return { filter() {}, first() {}, timeout() {} };
      return new Proxy({}, { get: () => function () {} });
    }
  });
  return exports;
}
const { NotesComponent } = load('src/app/components/notes/notes.component.ts');

function gridWithChecklistNote() {
  const grid = Object.create(NotesComponent.prototype);
  const saved = [];
  const note = { id: 7, isCbox: true, images: [], checkBoxes: [{ id: 0, data: 'Milk', done: false }] };
  Object.assign(grid, {
    masonrySignatureToken: 0,
    Shared: { note: { id: 0, db: { updateKey: async patch => { saved.push(patch) } } } },
    noteLock: { isLocked: () => false },
    cd: { detectChanges() {} },
    scheduleBuildMasonry() {},
    fileToNoteImage: async file => ({ id: 'img-1', dataUrl: 'data:' + file.type, placement: 'bottom' })
  });
  return { grid, note, saved };
}
const png = { type: 'image/png', name: 'red.png' };

test('dropping an image on a checklist card keeps it a checklist', async () => {
  const { grid, note, saved } = gridWithChecklistNote();
  await grid.dropImageOnNote(note, { dataTransfer: { files: [png] }, preventDefault() {}, stopPropagation() {} });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].images.length, 1);
  assert.equal('isCbox' in saved[0], false, 'the save must not touch isCbox');
  assert.equal(note.isCbox, true);
});

test("the card's image button keeps a checklist note a checklist", async () => {
  const { grid, note, saved } = gridWithChecklistNote();
  grid.overviewImageNote = note;
  await grid.overviewImageInputChange({ target: { files: [png], value: 'red.png' } });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].images.length, 1);
  assert.equal('isCbox' in saved[0], false, 'the save must not touch isCbox');
});
