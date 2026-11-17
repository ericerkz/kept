const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { parseDateSearch } = require('../shared/note-search-date');

const pipeExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/pipes/notes-tools.pipe.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText, { exports: pipeExports, require(name) {
  if (name.endsWith('/note-search-date')) return require('../shared/note-search-date');
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

for (const query of ['!date 1999', '!date:1999', '!date June 1999', '!date 1999-06-01']) {
  test(`${query} filters by creation date without searching for the date wording`, () => {
    assert.deepEqual(search([
      note(1, { noteTitle: 'Budget', createdAt: '1999-06-01T12:00:00' }),
      note(2, { noteTitle: 'Budget 1999', createdAt: '2026-06-01T12:00:00' }),
    ], query), [1]);
  });
}

test('a bare year stays literal text and other uses of on remain searchable', () => {
  const notes = [
    note(1, { noteTitle: 'Budget', createdAt: '1999-06-01T12:00:00' }),
    note(2, { noteTitle: 'Budget 1999', createdAt: '2026-06-01T12:00:00' }),
    note(3, { noteTitle: 'Turn on the lights', createdAt: '1999-06-01T12:00:00' }),
  ];
  assert.deepEqual(search(notes, '1999'), [2]);
  assert.deepEqual(search(notes, '!date 1999 on'), [3]);
});

for (const phrase of ['Created on 2025', 'created 2025', 'from 2025', 'today', 'yesterday', 'November', '2025-11-16']) {
  test(`ordinary text ${phrase} never silently becomes a date filter`, () => {
    assert.deepEqual(search([
      note(1, { noteTitle: phrase, createdAt: '1999-01-01T12:00:00' }),
      note(2, { noteTitle: 'Unrelated', createdAt: '2025-11-16T12:00:00' }),
    ], phrase), [1]);
  });
}

const now = new Date(2026, 10, 16, 12); // Monday, local time.
const day = value => new Date(...value).toISOString();
for (const [value, start, end] of [
  ['2025', [2025, 0, 1], [2026, 0, 1]],
  ['2025-11', [2025, 10, 1], [2025, 11, 1]],
  ['November 2025', [2025, 10, 1], [2025, 11, 1]],
  ['Nov', [2026, 10, 1], [2026, 11, 1]],
  ['2025-11-16', [2025, 10, 16], [2025, 10, 17]],
  ['2025/11/16', [2025, 10, 16], [2025, 10, 17]],
  ['November 16, 2025', [2025, 10, 16], [2025, 10, 17]],
  ['16 November 2025', [2025, 10, 16], [2025, 10, 17]],
  ['Nov 16', [2026, 10, 16], [2026, 10, 17]],
  ['today', [2026, 10, 16], [2026, 10, 17]],
  ['yesterday', [2026, 10, 15], [2026, 10, 16]],
  ['Monday', [2026, 10, 16], [2026, 10, 17]],
  ['last Monday', [2026, 10, 9], [2026, 10, 10]],
  ['Friday', [2026, 10, 13], [2026, 10, 14]],
  ['last week', [2026, 10, 9], [2026, 10, 16]],
  ['this month', [2026, 10, 1], [2026, 11, 1]],
  ['last month', [2026, 9, 1], [2026, 10, 1]],
  ['last year', [2025, 0, 1], [2026, 0, 1]],
  ['two years ago', [2024, 0, 1], [2025, 0, 1]],
  ['3 days ago', [2026, 10, 13], [2026, 10, 14]],
]) {
  test(`!date ${value} has the expected local calendar boundaries`, () => {
    const parsed = parseDateSearch(`budget !date ${value} !todo 1999`, now);
    assert.equal(parsed.invalid, false);
    assert.equal(parsed.range.start.toISOString(), day(start));
    assert.equal(parsed.range.end.toISOString(), day(end));
    assert.equal(parsed.text.replace(/\s+/g, ' '), 'budget !todo 1999');
    assert.equal(parsed.filters[0].value, value);
  });
}

for (const value of ['', 'unknown', '2025-02-29', '2025-02-30', '2025-13', 'February 30 2025', '0000', '100000000000 days ago']) {
  test(`invalid !date ${value} never broadens a search to all notes`, () => {
    assert.equal(parseDateSearch(`!date ${value}`, now).invalid, true);
    assert.deepEqual(search([note(1)], `!date ${value}`), []);
  });
}

test('date operators intersect, leap days validate, and local day ranges include DST changes', () => {
  assert.equal(parseDateSearch('!date 2024-02-29', now).invalid, false);
  const both = parseDateSearch('!date 2025 !date November 2025 budget', now);
  assert.equal(both.range.start.toISOString(), day([2025, 10, 1]));
  assert.equal(both.text, 'budget');
  assert.equal(parseDateSearch('!date 2025 !date 2026', now).invalid, true);
  const dst = parseDateSearch('!date 2026-03-08', now).range;
  assert.equal(dst.start.getHours(), 0);
  assert.equal(dst.end.getHours(), 0);
  assert.equal(dst.end.getDate(), 9);
});

test('date filtering uses inclusive start and exclusive end without consuming literal years', () => {
  assert.deepEqual(search([
    note(1, { noteTitle: 'Budget 1999', createdAt: new Date(2025, 0, 1).toISOString() }),
    note(2, { noteTitle: 'Budget 1999', createdAt: new Date(2026, 0, 1).toISOString() }),
    note(3, { noteTitle: 'Budget 2000', createdAt: new Date(2025, 5, 1).toISOString() }),
  ], 'budget !date 2025 1999'), [1]);
});

test('date filter controls apply, remove and clear the whole operand while preserving ordinary text', () => {
  const source = fs.readFileSync('src/app/components/navbar/navbar.component.ts', 'utf8');
  const ast = ts.createSourceFile('navbar.ts', source, ts.ScriptTarget.Latest, true);
  const component = ast.statements.find(node => ts.isClassDeclaration(node));
  const names = ['applyDateFilter', 'clearDateFilter', 'clearAllFilters', 'hasDateFilter', 'toggleDateFilter', 'focusDateSearch', 'isDateExampleActive', 'onSearchFocus'];
  const methods = component.members.filter(node => node.name && names.includes(node.name.getText(ast)))
    .map(node => node.getText(ast)).join('\n');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(`class Harness {${methods}}; exports.Harness = Harness;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports, parseDateSearch, uiText: key => key });
  const navbar = new exports.Harness();
  navbar.Shared = { searchQuery: 'budget 1999 !date November 2025 !todo', setSearchQuery(value) { this.searchQuery = value; } };
  assert.equal(navbar.hasDateFilter, true);
  navbar.clearDateFilter();
  assert.equal(navbar.Shared.searchQuery.replace(/\s+/g, ' '), 'budget 1999 !todo');
  navbar.isFiltersOpen = true;
  const input = { value: '', focus() { navbar.onSearchFocus(); }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  navbar.searchInput = {nativeElement: input};
  navbar.toggleDateFilter();
  assert.equal(navbar.Shared.searchQuery, 'budget 1999 !todo !date ');
  assert.equal(navbar.hasDateFilter, true);
  navbar.applyDateFilter('november');
  assert.equal(navbar.Shared.searchQuery, 'budget 1999 !todo !date november');
  assert.equal(navbar.isDateExampleActive('november'),true);
  assert.equal(navbar.isDateExampleActive('2025'),false);
  navbar.applyDateFilter('yesterday');
  assert.equal(navbar.Shared.searchQuery, 'budget 1999 !todo !date yesterday');
  const before = navbar.Shared.searchQuery;
  navbar.applyDateFilter('2025-02-30');
  assert.equal(navbar.Shared.searchQuery, before);
  assert.equal(navbar.isFiltersOpen,true,'examples leave the panel open');
  assert.equal(navbar.searchExpanded,false,'focusing search must not hide the mobile filter panel');
  assert.equal(input.selectionStart,input.value.length);
  navbar.toggleDateFilter();
  assert.equal(navbar.Shared.searchQuery,'budget 1999 !todo');
  assert.equal(navbar.hasDateFilter,false);
  navbar.applyDateFilter('2025');
  navbar.clearAllFilters();
  assert.equal(navbar.Shared.searchQuery, 'budget 1999');
});

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
  assert.deepEqual(search(notes, '工作 !image !label:projects !date 2026-11-14'), [1]);
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
