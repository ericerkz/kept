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
let uuid = 0;
const context = vm.createContext({
  Capacitor: { getPlatform: () => 'web' }, createUuid: () => `fixture-${++uuid}`,
  console: { error() {} }
});
vm.runInContext(stripTypeScriptTypes(`class Editor {
  ${['saveNote', 'persistNote', 'currentNoteId', 'clearComposerDraft'].map(method).join('\n')}
}
globalThis.Editor = Editor;`), context);

function editor() {
  const rows = new Map();
  const instance = new context.Editor();
  Object.assign(instance, {
    saveQueue: Promise.resolve(), editorGeneration: 0, canSaveNote: true, noteToEdit: {},
    noteTitle: { nativeElement: { innerHTML: '' } },
    noteBody: { nativeElement: { innerHTML: '' } },
    noteMain: { nativeElement: { style: {} } },
    noteContainer: { nativeElement: { style: {} } },
    notePin: { nativeElement: { dataset: {} } },
    isCbox: { value: false }, images: [], attachments: [], pendingAttachmentFiles: [],
    selectedCollaboratorIds: [],
    labelsForSave: async () => [], sharedBinderFromRoute: () => undefined,
    currentCheckBoxesForSave: () => [], cleanEditorBodyForSave: html => html,
    hasMeaningfulBody: html => !!html?.trim(),
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
  ['checklist', { currentCheckBoxesForSave: () => [{ id: 1, data: '', done: false }] }],
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
