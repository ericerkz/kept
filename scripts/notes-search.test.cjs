const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const pipeExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/pipes/notes-tools.pipe.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText, { exports: pipeExports, require(name) {
  if (name === '@angular/core') return { Pipe: () => value => value };
  return {};
} });

function note(id, fields = {}) {
  return { id, noteTitle: '', noteBody: '', labels: [], archived: false, trashed: false, ...fields };
}

function search(notes, query) {
  const pipe = new pipeExports.NotesToolsPipe({}, { currentUser: { id: 1 } });
  return Array.from(pipe.transform(notes, 'home', query), note => note.id);
}

for (const [name, query, text] of [
  ['Chinese', '工作', '普通工作记录'],
  ['Cyrillic case folding', 'РАБОТА', 'работа'],
  ['Arabic', 'عمل', 'سجل عمل'],
  ['Devanagari combining marks', 'किताब', 'किताब'],
  ['Japanese combining dakuten', 'がく', 'がく'],
  ['Unicode numbers', '１２３', '番号１２３'],
]) {
  test(`${name} search excludes unrelated notes in titles and bodies`, () => {
    assert.deepEqual(search([
      note(1, { noteTitle: text }),
      note(2, { noteBody: text }),
      note(3, { noteTitle: 'English unrelated' }),
    ], query), [1, 2]);
  });
}

test('combining marks that distinguish non-Latin words are not discarded', () => {
  assert.deepEqual(search([
    note(1, { noteTitle: 'किताब' }),
    note(2, { noteTitle: 'कतब' }),
    note(3, { noteTitle: 'がく' }),
    note(4, { noteTitle: 'かく' }),
  ], 'किताब'), [1]);
  assert.deepEqual(search([
    note(1, { noteTitle: 'がく' }),
    note(2, { noteTitle: 'かく' }),
  ], 'がく'), [1]);
  assert.deepEqual(search([
    note(1, { noteTitle: 'й' }),
    note(2, { noteTitle: 'и' }),
  ], 'й'), [1]);
});

test('Latin accents, case, punctuation and multi-token matching stay compatible', () => {
  assert.deepEqual(search([
    note(1, { noteTitle: 'CAFÉ, résumé!' }),
    note(2, { noteTitle: 'cafe only' }),
  ], 'cafe resume'), [1]);
});

test('ASCII operators still combine with text and ISO dates', () => {
  const fields = { noteTitle: '工作 café', createdAt: '2026-11-14T12:00:00', labels: [{ name: 'Projects', added: true }], images: [{ id: 'photo' }] };
  const notes = [
    note(1, fields),
    note(2, { ...fields, images: [] }),
    note(3, { ...fields, createdAt: '2026-11-13T12:00:00' }),
    note(4, { ...fields, labels: [] }),
    note(5, { ...fields, noteTitle: 'English unrelated' }),
  ];
  assert.deepEqual(search(notes, '工作 !image !label:projects 2026-11-14'), [1]);
});

test('existing ASCII label slugs stay compatible with navbar suggestions', () => {
  assert.deepEqual(search([
    note(1, { labels: [{ name: 'Project 工作', added: true }] }),
    note(2, { labels: [{ name: 'Other', added: true }] }),
  ], '!label:project'), [1]);
});

for (const [query, fields] of [
  ['!image', { images: [{ id: 'photo' }] }],
  ['!todo', { isCbox: true }],
  ['!drawing', { images: [{ id: 'drawing' }] }],
  ['!label', { labels: [{ name: 'Projects', added: true }] }],
  ['!url', { noteBody: 'https://example.com' }],
  ['!attachment', { hasAttachments: true }],
]) {
  test(`${query} still filters without literal text`, () => {
    assert.deepEqual(search([note(1, fields), note(2)], query), [1]);
  });
}
