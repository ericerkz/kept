const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { BehaviorSubject } = require('rxjs');

const exportsForService = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/services/shared.service.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText, { exports: exportsForService, require(name) {
  if (name === '@angular/core') return { Injectable: () => value => value };
  return {};
} });

function selection(archived, ids = archived.map((_, index) => index + 1)) {
  const shared = Object.create(exportsForService.SharedService.prototype);
  const notes = archived.map((value, index) => ({ id: index + 1, archived: value, trashed: false }));
  Object.assign(shared, {
    note: { all: notes },
    selectedNoteIds: new BehaviorSubject(ids),
    Notes: { async updateKey(patch, id) { Object.assign(notes.find(note => note.id === id), patch); } }
  });
  return shared;
}

for (const { name, archived, ids, want } of [
  { name: 'unarchives every selected archived note', archived: [true, true, true], ids: [1, 2], want: [false, false, true] },
  { name: 'archives active notes', archived: [false, false], ids: [1, 2], want: [true, true] },
  { name: 'archives a mixed selection consistently', archived: [true, false], ids: [1, 2], want: [true, true] }
]) {
  test(name, async () => {
    const shared = selection(archived, ids);
    await shared.bulkArchiveSelected();
    assert.deepEqual(shared.note.all.map(note => note.archived), want);
    assert.ok(shared.note.all.every(note => !note.trashed));
    assert.equal(shared.selectedNoteIds.value.length, 0);
  });
}

test('a failed bulk update retains the selection and reports the failure', async () => {
  const shared = selection([true, true]);
  shared.Notes.updateKey = async () => { throw new Error('Could not save'); };
  await assert.rejects(shared.bulkArchiveSelected(), /Could not save/);
  assert.deepEqual(shared.selectedNoteIds.value, [1, 2]);
});

test('the toolbar derives its archive state from the selection, not other notes', () => {
  const shared = selection([true, true, false], [1, 2]);
  assert.equal(shared.selectedNotesArchived, true);
  shared.selectedNoteIds.next([1, 3]);
  assert.equal(shared.selectedNotesArchived, false);
  shared.clearNoteSelection();
  assert.equal(shared.selectedNotesArchived, false);
});
