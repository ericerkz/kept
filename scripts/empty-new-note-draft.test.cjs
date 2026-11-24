const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');

const source = readFileSync('src/app/components/input/input.component.ts', 'utf8');
function method(name) {
  const match = new RegExp(`^  (?:private )?(?:async )?${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing method ${name}`);
  return source.slice(match.index, source.indexOf('\n  }', match.index) + 4);
}
const placement = {};
vm.runInNewContext(require('typescript').transpileModule(readFileSync('src/app/utils/checklist-placement.ts', 'utf8'), {
  compilerOptions: { module: require('typescript').ModuleKind.CommonJS }
}).outputText, { exports: placement, require: () => ({}) });
let uuid = 0;
const context = vm.createContext({
  Capacitor: { getPlatform: () => 'web' }, createUuid: () => `fixture-${++uuid}`,
  console: { error() {} }, serializeChecklistBody: placement.serializeChecklistBody, checklistId: placement.checklistId
});
vm.runInContext(stripTypeScriptTypes(`class Editor {
  ${['saveNote', 'persistNote', 'currentNoteId', 'clearComposerDraft', 'editorBodyParts', 'editorBodyHtml', 'withoutEmptyChecklistRows', 'joinBodyHtml'].map(method).join('\n')}
  ${source.slice(source.indexOf('  get canSaveNote()'), source.indexOf('\n  }', source.indexOf('  get canSaveNote()')) + 4)}
}
globalThis.Editor = Editor;`), context);

function editor() {
  const rows = new Map();
  const instance = new context.Editor();
  Object.assign(instance, {
    saveQueue: Promise.resolve(), editorGeneration: 0, noteToEdit: {},
    noteTitle: { nativeElement: { innerHTML: '' } },
    noteBody: { nativeElement: { innerHTML: '' } },
    noteMain: { nativeElement: { style: {} } },
    noteContainer: { nativeElement: { style: {} } },
    notePin: { nativeElement: { dataset: {} } },
    checkBoxes: [], checklistBlocks: [],
    editorBodies: () => [instance.noteBody.nativeElement],
    checklistDrafts: () => instance.cboxPh ? [instance.cboxPh.nativeElement] : [],
    bodyAfterChecklist: id => instance.trailingBodies?.[id],
    isCbox: { value: false }, images: [], attachments: [], pendingAttachmentFiles: [],
    selectedCollaboratorIds: [],
    labelsForSave: async () => [], sharedBinderFromRoute: () => undefined,
    currentCheckBoxesForSave: () => [], cleanEditorBodyForSave: html => html,
    hasMeaningfulBody: html => !!html?.replace(/<[^>]*>/g, '').replace(/[\u200b-\u200d\ufeff]/g, '').trim() || /<(img|hr|table)\b/.test(html || ''),
    auth: { canonicalImageUrl: url => url, isAuthExpiredError: () => false },
    reminderService: { reminders$: { value: [] } },
    noteChangedForSave: () => true, noteSaveSnapshot: JSON.stringify,
    applyPendingCollaborators: async () => {}, uploadPendingAttachments: async () => {},
    flushPendingReminderSaves: () => {},
    closeNote: () => { instance.closed = true; instance.editorGeneration++; },
    showNoteSaveError: () => { instance.saveError = true; },
    Shared: { note: { db: { add: async note => { rows.set(12, note); return 12; } } } },
    notesService: {
      notesList$: { value: [] },
      update: async (note, id) => rows.set(id, note),
      discardDraft: async syncId => {
        for (const [id, note] of rows) if (note.syncId === syncId) rows.delete(id);
      }
    }
  });
  return { instance, rows };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('persistence boundary was not reached');
}

test('an autosaved new draft cleared before closing is removed, not updated to empty', async () => {
  const { instance, rows } = editor();
  instance.noteBody.nativeElement.innerHTML = 'draft';
  await instance.saveNote(false);
  instance.noteBody.nativeElement.innerHTML = '';
  await instance.saveNote();
  assert.equal(rows.size, 0);
  assert.equal(instance.closed, true);
});

test('clearing during an in-flight create cannot leave a stale note behind', async () => {
  const { instance, rows } = editor();
  let release;
  const add = instance.Shared.note.db.add;
  instance.Shared.note.db.add = async note => {
    await new Promise(resolve => { release = resolve; });
    return add(note);
  };
  instance.noteBody.nativeElement.innerHTML = 'draft';
  const first = instance.saveNote(false);
  await waitFor(() => release);
  instance.noteBody.nativeElement.innerHTML = '';
  const close = instance.saveNote();
  release();
  await Promise.all([first, close]);
  assert.equal(rows.size, 0);
});

test('a failed discard keeps the draft identity and composer available for retry', async () => {
  const { instance, rows } = editor();
  instance.noteBody.nativeElement.innerHTML = 'draft';
  await instance.saveNote(false);
  instance.noteBody.nativeElement.innerHTML = '';
  instance.notesService.discardDraft = async () => { throw new Error('storage unavailable'); };
  assert.equal(await instance.saveNote(), false);
  assert.equal(instance.newNoteId, 12);
  assert.equal(rows.size, 1);
  assert.equal(instance.closed, undefined);
  assert.equal(instance.saveError, true);
});

test('typing while discard is pending is saved under a fresh identity before closing', async () => {
  const { instance, rows } = editor();
  instance.noteBody.nativeElement.innerHTML = 'draft';
  await instance.saveNote(false);
  const originalSyncId = instance.newNoteSyncId;
  let release;
  const discard = instance.notesService.discardDraft;
  instance.notesService.discardDraft = async syncId => {
    await new Promise(resolve => { release = resolve; });
    await discard(syncId);
  };
  instance.noteBody.nativeElement.innerHTML = '';
  const close = instance.saveNote();
  await waitFor(() => release);
  instance.noteBody.nativeElement.innerHTML = 'new typing';
  release();
  await close;
  assert.equal(rows.size, 1);
  assert.equal(rows.get(12).noteBody, 'new typing');
  assert.notEqual(rows.get(12).syncId, originalSyncId);
});

for (const [name, patch] of [
  ['title', { noteTitle: { nativeElement: { innerHTML: 'Title only' } } }],
  ['image', { images: [{ dataUrl: '/image.png' }] }],
  ['attachment', { attachments: [{ id: 1 }] }],
  ['pending attachment', { pendingAttachmentFiles: [{}] }],
  ['checklist', { checkBoxes: [{ id: 1, data: '', done: false }], currentCheckBoxesForSave: () => [{ id: 1, data: '', done: false }] }],
  ['drawing', { isDrawingNote: true, syncDrawingImage: () => {} }],
  ['pending reminder', { pendingReminderDate: new Date('2030-01-01') }],
  ['saved reminder', { newNoteId: 12, newNoteSyncId: 'reminder-note', reminderService: { reminders$: { value: [{ noteId: 12 }] } } }]
]) test(`${name} keeps a new note even without body text`, async () => {
  const { instance, rows } = editor();
  Object.assign(instance, patch);
  await instance.saveNote();
  assert.equal(rows.size, 1);
});

test('existing saved notes may be intentionally emptied', async () => {
  const { instance, rows } = editor();
  instance.isEditing = true;
  instance.noteToEdit = { id: 20 };
  await instance.saveNote(false);
  assert.equal(rows.size, 1);
  assert.equal(rows.get(20).noteBody, '');
});

for (const close of [false, true]) test(`empty checklist placeholder HTML is not materialized as a row (close=${close})`, async () => {
  const { instance, rows } = editor();
  instance.isCbox.value = true;
  instance.cboxPh = { nativeElement: { innerHTML: '<br>' } };
  instance.hasMeaningfulBody = html => !!html && html !== '<br>';
  instance.addCheckBoxFromPlaceholder = () => assert.fail('empty placeholder must not become a row');
  assert.notEqual(await instance.saveNote(close), false);
  assert.equal(rows.size, 0);
});

test('discard replaces queued writes and survives an acknowledgement of an in-flight create', async () => {
  const { createStore } = require('../test-support/workspace-store.cjs');
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('draft-test');
  await store.commitMutation(workspace, 'reminder.upsert', 'standalone-reminder', { title: 'Unrelated reminder' });
  await store.commitMutation(workspace, 'note.upsert', 'draft', { noteBody: 'typed text' });
  const sent = (await store.listOutbox(workspace.partition)).find(entry => entry.syncId === 'draft');
  await store.commitMutation(workspace, 'note.upsert', 'unrelated', { noteBody: 'Keep this note' });
  const serviceSource = readFileSync('src/app/services/notes.service.ts', 'utf8');
  const start = serviceSource.indexOf('  async discardDraft(');
  const discard = serviceSource.slice(start, serviceSource.indexOf('\n  }', start) + 4);
  const serviceContext = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(`class Notes { ${discard} } globalThis.Notes = Notes;`), serviceContext);
  const service = new serviceContext.Notes();
  Object.assign(service, {
    offlineSync: { commit: (...args) => store.commitMutation(workspace, ...args) },
    load: async () => {}, reminders: { load: async () => {} }
  });
  await service.discardDraft('draft');
  await service.discardDraft('draft');
  assert.equal((await store.listReminders(workspace.partition)).length, 1, 'retrying discard must not delete standalone reminders');
  const queued = await store.listOutbox(workspace.partition);
  assert.deepEqual(Array.from(queued.filter(entry => entry.syncId === 'draft'), entry => entry.type), ['note.delete']);
  await store.reconcile(workspace, {
    sent: [sent],
    results: [{ operationId: sent.operationId, ok: true, canonical: { id: 42, syncId: 'draft', noteBody: 'typed text' } }],
    cursor: 1
  });
  assert.deepEqual(Array.from(await store.listNotes(workspace.partition), note => note.noteBody), ['Keep this note']);
  assert.equal((await store.listOutbox(workspace.partition)).some(entry => entry.type === 'note.delete' && entry.syncId === 'draft'), true);
});

for (const listId of ['first', 'second']) test(`text after checklist ${listId} keeps a draft and its placement`, async () => {
  const { instance, rows } = editor();
  instance.isCbox.value = true;
  instance.checklistBlocks = [{ id: 'first' }, { id: 'second' }];
  instance.trailingBodies = { [listId]: { innerHTML: '<b>Keep this text</b>' } };
  instance.editorBodies = () => Object.values(instance.trailingBodies);
  assert.equal(instance.canSaveNote, true);
  await instance.saveNote(false);
  assert.equal(rows.size, 1);
  assert.match(rows.get(12).noteBody, /kept-list-first/);
  assert.match(rows.get(12).noteBody, /kept-list-second/);
  assert.ok(rows.get(12).noteBody.includes('<b>Keep this text</b>'));
});

test('an unfinished row in a non-active checklist is autosaved with its list identity', async () => {
  const { instance, rows } = editor();
  instance.isCbox.value = true;
  instance.checklistBlocks = [{ id: 'first' }, { id: 'second' }];
  instance.checklistDrafts = () => [{ innerHTML: '<i>Still typing</i>', dataset: { checklistDraft: 'second' } }];
  assert.equal(instance.canSaveNote, true);
  await instance.saveNote(false);
  assert.equal(rows.size, 1);
  assert.equal(rows.get(12).checkBoxes[0].data, '<i>Still typing</i>');
  assert.equal(rows.get(12).checkBoxes[0].listId, 'second');
});

test('empty checklist markers alone do not preserve a cleared new draft', async () => {
  const { instance, rows } = editor();
  instance.isCbox.value = true;
  instance.checklistBlocks = [{ id: 'first' }, { id: 'second' }];
  await instance.saveNote();
  assert.equal(rows.size, 0);
  assert.equal(instance.closed, true);
});

test('saving a drawing retains its stored body without a text editor', async () => {
  const { instance, rows } = editor();
  instance.noteBody = undefined;
  instance.isDrawingNote = true;
  instance.syncDrawingImage = () => {};
  instance.noteToEdit = { noteBody: '<b>Drawing description</b>' };
  await instance.saveNote(false);
  assert.equal(rows.get(12).noteBody, '<b>Drawing description</b>');
});

test('closing keeps empty rows in a list that has items', async () => {
  const { instance, rows } = editor();
  instance.isCbox.value = true;
  instance.checklistBlocks = [{ id: 'a' }];
  instance.noteBody.nativeElement.innerHTML = 'Intro';
  instance.currentCheckBoxesForSave = () => [
    { id: 0, listId: 'a', data: 'Milk', done: false, indentLevel: 0 },
    { id: 1, listId: 'a', data: '<br>', done: false, indentLevel: 0 },
    { id: 2, listId: 'a', data: '', done: true, indentLevel: 0 }
  ];
  await instance.saveNote(true);
  const note = rows.get(12);
  assert.deepEqual(note.checkBoxes.map(row => row.data), ['Milk', '<br>', '']);
  assert.equal(note.isCbox, true);
  assert.match(note.noteBody, /kept-list-a/);
});

test('closing removes only the list with nothing typed in it', async () => {
  const { instance, rows } = editor();
  instance.isCbox.value = true;
  instance.checklistBlocks = [{ id: 'a' }, { id: 'b' }];
  instance.noteBody.nativeElement.innerHTML = 'Intro';
  instance.trailingBodies = { a: { innerHTML: '<div>Between</div>' }, b: { innerHTML: '<div>After</div>' } };
  instance.joinBodyHtml = (above, below) => above + below;
  instance.currentCheckBoxesForSave = () => [
    { id: 0, listId: 'a', data: 'Milk', done: false, indentLevel: 0 },
    { id: 1, listId: 'b', data: '', done: false, indentLevel: 0 }
  ];
  await instance.saveNote(true);
  const note = rows.get(12);
  assert.deepEqual(note.checkBoxes.map(row => row.listId), ['a']);
  assert.equal(note.isCbox, true);
  assert.match(note.noteBody, /kept-list-a/);
  assert.doesNotMatch(note.noteBody, /kept-list-b/);
  assert.match(note.noteBody, /Between<\/div><div>After/);
});

test('closing with only an empty checklist removes the list and keeps the text', async () => {
  const { instance, rows } = editor();
  instance.isCbox.value = true;
  instance.checklistBlocks = [{ id: 'a' }];
  instance.noteBody.nativeElement.innerHTML = 'asd';
  instance.currentCheckBoxesForSave = () => [{ id: 0, listId: 'a', data: '', done: false, indentLevel: 0 }];
  await instance.saveNote(true);
  const note = rows.get(12);
  assert.deepEqual(note.checkBoxes, []);
  assert.equal(note.isCbox, false);
  assert.equal(note.noteBody, 'asd');
});

test('autosave while editing keeps an empty row being typed into', async () => {
  const { instance, rows } = editor();
  instance.isCbox.value = true;
  instance.checklistBlocks = [{ id: 'a' }];
  instance.noteBody.nativeElement.innerHTML = 'asd';
  instance.currentCheckBoxesForSave = () => [{ id: 0, listId: 'a', data: '', done: false, indentLevel: 0 }];
  await instance.saveNote(false);
  assert.equal(rows.get(12).checkBoxes.length, 1);
});
