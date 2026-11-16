const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { BehaviorSubject } = require('rxjs');

function load(file, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console, setTimeout, clearTimeout, ...globals, require(name) {
    if (name.endsWith('/note-search-date')) return require('../shared/note-search-date');
    if (name === '@angular/core') return {
      ...Object.fromEntries(['Component', 'Injectable', 'Pipe'].map(key => [key, () => value => value])),
      ...Object.fromEntries(['ViewChild', 'ViewChildren', 'HostListener'].map(key => [key, () => () => {}]))
    };
    if (name === '@capacitor/core') return { registerPlugin: () => ({}) };
    if (name.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
    return {};
  } });
  return exports;
}

function harness() {
  let dialog = false;
  let legacyModal = false;
  const { NotesComponent } = load('src/app/components/notes/notes.component.ts', {
    document: { querySelectorAll: selector => dialog || (legacyModal && selector.includes('.modal-container'))
      ? [{ getClientRects: () => [1] }] : [] }
  });
  const { NotesToolsPipe } = load('src/app/pipes/notes-tools.pipe.ts');
  const shared = {
    note: { all: [] }, selectedNoteIds: new BehaviorSubject([]),
    searchQuery: '', searchScope: new BehaviorSubject('current'), composerDraftSyncId: 'draft'
  };
  const component = Object.create(NotesComponent.prototype);
  const service = { async loadAllPages() {} };
  Object.assign(component, {
    Shared: shared, notesService: service, currentPageName: 'home',
    notesTools: new NotesToolsPipe({ reminders$: new BehaviorSubject([]) }, { currentUser: { id: 7 } }),
    modalContainer: { nativeElement: { style: { display: 'none' } } },
    showMessage(message) { this.error = message; }
  });
  const note = (id, extra = {}) => ({ id, archived: false, trashed: false, labels: [],
    noteTitle: 'match', pinned: id % 2 === 0, ...extra });
  shared.note.all = [note(1), note(2, { ownerUserId: 8, sharedBinder: { id: 9 }, hasAttachments: true }),
    note(3, { archived: true }), note(4, { trashed: true }),
    note(5, { binder: 'Work' }), note(6, { labels: [{ name: 'Test', added: true }] }),
    note(7, { syncId: 'draft' }), note(undefined)];
  return { component, shared, service, note, setDialog(value) { dialog = value; },
    setLegacyModal(value) { legacyModal = value; } };
}

for (const [section, ids] of [['home', [1, 2, 6]], ['archived', [3]], ['trashed', [4]],
  ['binder:Work', [5]], ['Test', [6]], ['shared', [2]], ['shared-binder:9', [2]], ['attachments', [2]]]) {
  test(`selects only ${section} notes, including pinned and unpinned`, async () => {
    const { component, shared } = harness();
    component.currentPageName = section;
    await component.selectAllNotes();
    assert.deepEqual([...shared.selectedNoteIds.value], ids);
    assert.ok(shared.note.all.every(note => note.trashed === (note.id === 4)));
  });
}

test('search uses the same current/all scope as the grid, including zero results', async () => {
  const { component, shared } = harness();
  shared.searchQuery = 'match';
  await component.selectAllNotes();
  assert.deepEqual([...shared.selectedNoteIds.value], [1, 2, 6]);
  shared.searchScope.next('all');
  await component.selectAllNotes();
  assert.deepEqual([...shared.selectedNoteIds.value], [1, 2, 5, 6]);
  shared.searchQuery = 'zzzzzzzzzz';
  await component.selectAllNotes();
  assert.deepEqual([...shared.selectedNoteIds.value], []);
});

test('selects matching pages beyond rendering limits and replaces rather than toggles selection', async () => {
  const { component, shared, service, note } = harness();
  component.visibleNoteLimit = 1;
  service.loadAllPages = async () => { shared.note.all.push(note(90)); };
  shared.selectedNoteIds.next([3]);
  await component.selectAllNotes();
  assert.deepEqual([...shared.selectedNoteIds.value], [1, 2, 6, 90]);
  await component.selectAllNotes();
  assert.deepEqual([...shared.selectedNoteIds.value], [1, 2, 6, 90]);
});

test('does not select stale results after navigation, editing, or clearing selection during loading', async () => {
  for (const change of [
    h => { h.component.currentPageName = 'archived'; },
    h => { h.shared.searchQuery = 'different'; },
    h => { h.shared.selectedNoteIds.next([]); },
    h => { h.component.modalContainer.nativeElement.style.display = 'block'; },
    h => { h.component.destroyed = true; }
  ]) {
    const h = harness();
    h.service.loadAllPages = async () => change(h);
    await h.component.selectAllNotes();
    assert.deepEqual([...h.shared.selectedNoteIds.value], []);
  }
});

test('a load failure preserves selection and reports an error', async () => {
  const { component, shared, service } = harness();
  shared.selectedNoteIds.next([1]);
  service.loadAllPages = async () => { throw Error('offline'); };
  await component.selectAllNotes();
  assert.deepEqual([...shared.selectedNoteIds.value], [1]);
  assert.ok(component.error);
});

test('Ctrl+A and Cmd+A work before selection, without hijacking editing or dialogs', async () => {
  const h = harness();
  for (const modifier of ['ctrlKey', 'metaKey']) {
    let prevented = false;
    const event = { key: 'a', [modifier]: true, target: { tagName: 'DIV', closest: () => null },
      preventDefault() { prevented = true; } };
    await h.component.onSelectAllKey(event);
    assert.equal(prevented, true);
    assert.deepEqual([...h.shared.selectedNoteIds.value], [1, 2, 6]);
  }
  for (const target of [
    { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
    { tagName: 'SPAN', isContentEditable: true }, { tagName: 'BUTTON', closest: () => ({}) }
  ]) {
    await h.component.onSelectAllKey({ key: 'a', ctrlKey: true, target,
      preventDefault() { assert.fail('native selection must remain available'); } });
  }
  h.setDialog(true);
  await h.component.onSelectAllKey({ key: 'a', metaKey: true, target: { tagName: 'BODY', closest: () => null },
    preventDefault() { assert.fail('dialog is open'); } });
});

test('pagination waits for existing loads, fetches every remaining page and propagates failures', async () => {
  const { NotesService } = load('src/app/services/notes.service.ts');
  const service = Object.create(NotesService.prototype);
  Object.assign(service, { isLoading: true, nextCursor: 'first', searchReloadTimer: undefined });
  service.delay = async () => { service.isLoading = false; };
  let pages = 0;
  service.loadNextPage = async () => { service.nextCursor = ++pages === 2 ? null : 'second'; };
  await service.loadAllPages();
  assert.equal(pages, 2);
  service.nextCursor = 'first';
  service.loadNextPage = async () => { throw Error('network'); };
  await assert.rejects(service.loadAllPages(), /network/);
});

test('legacy catalog modals without dialog roles also preserve native select all', async () => {
  const h = harness();
  h.setLegacyModal(true);
  await h.component.onSelectAllKey({ key: 'a', ctrlKey: true, target: { tagName: 'BUTTON', closest: () => null },
    preventDefault() { assert.fail('catalog modal is open'); } });
  assert.deepEqual([...h.shared.selectedNoteIds.value], []);
});
