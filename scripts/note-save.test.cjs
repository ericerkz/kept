const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createStore } = require('../test-support/workspace-store.cjs');

function loadClass(file, name) {
  const exports = {};
  const decorator = () => value => value;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console: { ...console, error() {} }, require(id) {
    if (id === '@angular/core') return { Injectable: decorator, Component: decorator, ViewChild: () => () => {},
      Input: () => () => {}, HostBinding: () => () => {}, HostListener: () => () => {} };
    if (id === '@capacitor/core') return { registerPlugin: () => ({}) };
    if (id.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
    return {};
  } });
  return exports[name];
}
const Notes = loadClass('src/app/services/notes.service.ts', 'NotesService');
const Input = loadClass('src/app/components/input/input.component.ts', 'InputComponent');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(local = false) {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('note-save');
  if (local) { workspace.mode = 'local'; await store.saveWorkspace(workspace); }
  const original = await store.commitMutation(workspace, 'note.upsert', 'saved-note', { id: 42, noteTitle: 'Title', noteBody: 'Before', images: [], labels: [] });
  const service = Object.create(Notes.prototype);
  Object.assign(service, { offlineStore: store, offlineSync: { writesLocally: true, partition: workspace.partition, generation: workspace.generation,
    commit: (type, syncId, note) => store.commitMutation(workspace, type, syncId, note) },
    cachedOrLoadedNote: async () => original, canonicalizeNoteMedia: note => note,
    localReminderRefreshQueue: Promise.resolve(), mergeNoteIntoList: note => { service.published = note; },
    load: () => assert.fail('commit already requests a cache refresh; do not hydrate the whole library again') });
  const editor = Object.create(Input.prototype);
  const ref = extra => ({ nativeElement: { innerHTML: '', style: {}, dataset: {}, ...extra } });
  Object.assign(editor, { isEditing: true, noteToEdit: original, destroyed: false, editorGeneration: 0, saveQueue: Promise.resolve(),
    noteTitle: ref({ innerHTML: 'Title edited' }), noteMain: ref({ style: { backgroundColor: '' } }),
    notePin: ref({ dataset: { pinned: 'false' } }), cboxInput: ref({ blur() {} }),
    labelsForSave: async () => [], isDrawingNote: false, isCbox: { value: false },
    currentCheckBoxesForSave: () => [], editorBodyHtml: () => '<p>Final mobile edit</p>',
    images: [], attachments: [], pendingAttachmentFiles: [], selectedCollaboratorIds: [],
    hasMeaningfulBody: value => !!value, noteChangedForSave: () => true, noteSaveSnapshot: JSON.stringify,
    notesService: service, auth: { canonicalImageUrl: value => value, isAuthExpiredError: () => false },
    uploadPendingAttachments: async () => {}, flushPendingReminderSaves() {}, updateLastEditedTime() {},
    Shared: { closeModal: { next: () => { editor.closed = true; } } },
    showNoteSaveError: () => { editor.errorShown = true; } });
  return { store, workspace, service, editor };
}

for (const local of [false, true]) test(`mobile Back closes after durable save without waiting for reminders (${local ? 'device-only' : 'server'})`, async () => {
  const { store, workspace, service, editor } = await fixture(local);
  const commitGate = deferred(), reminderGate = deferred(), reminderStarted = deferred();
  const commit = service.offlineSync.commit;
  service.offlineSync.commit = async (...args) => { await commitGate.promise; return commit(...args); };
  service.reminders = { refreshNoteContent: async () => { reminderStarted.resolve(); await reminderGate.promise; } };
  editor.mobileBack();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.closed, undefined, 'never close before the local transaction commits');
  commitGate.resolve();
  await editor.saveQueue;
  await reminderStarted.promise;
  assert.equal(editor.closed, true, 'reminder/native follow-up must not hold the editor open');
  assert.equal(service.published.noteBody, '<p>Final mobile edit</p>', 'overview receives the saved edit immediately');
  assert.equal((await store.getNote(workspace.partition, 42)).noteBody, '<p>Final mobile edit</p>');
  if (!local) assert.ok((await store.listOutbox(workspace.partition)).some(entry => entry.payload.noteBody === '<p>Final mobile edit</p>'));
  reminderGate.resolve();
  await service.localReminderRefreshQueue;
});

test('a new local-first note publishes after its commit without waiting for a library reload', async () => {
  const { store, workspace, service } = await fixture();
  service.prependNotesIntoList = notes => { service.published = notes[0]; };
  const id = await service.add({ syncId: 'fresh-note', noteTitle: 'New mobile note', noteBody: 'Saved before Back', bgColor: '' });
  assert.equal(service.published.id, id);
  assert.equal((await store.getNote(workspace.partition, id)).noteBody, 'Saved before Back');
  assert.ok((await store.listOutbox(workspace.partition)).some(entry => entry.syncId === 'fresh-note'));
});

test('failed local storage keeps the editor open and reports the save failure', async () => {
  const { store, workspace, service, editor } = await fixture();
  service.offlineSync.commit = async () => { throw new Error('Storage failed'); };
  service.reminders = { refreshNoteContent: () => assert.fail('no reminders after a failed save') };
  editor.mobileBack();
  assert.equal(await editor.saveQueue, false);
  assert.equal(editor.closed, undefined);
  assert.equal(editor.errorShown, true);
  assert.equal((await store.getNote(workspace.partition, 42)).noteBody, 'Before');
});

test('rapid saves keep reminder follow-up ordered and use the latest committed content', async () => {
  const { service, editor } = await fixture();
  const gate = deferred(), started = deferred();
  const bodies = [];
  service.reminders = { refreshNoteContent: async note => { bodies.push(note.noteBody); if (bodies.length === 1) { started.resolve(); await gate.promise; } } };
  await editor.saveNote(false);
  await started.promise;
  editor.editorBodyHtml = () => 'Second edit';
  await editor.saveNote(false);
  editor.editorBodyHtml = () => 'Latest edit';
  editor.mobileBack();
  await editor.saveQueue;
  assert.equal(editor.closed, true);
  gate.resolve();
  await service.localReminderRefreshQueue;
  assert.equal(bodies.at(-1), 'Latest edit');
  assert.ok(bodies.slice(1).every(body => body === 'Latest edit'), 'pending refreshes never replay older saved text');
});

test('queued reminder work does not cross a workspace generation change', async () => {
  const { service, editor } = await fixture();
  const gate = deferred();
  service.localReminderRefreshQueue = gate.promise;
  service.reminders = { refreshNoteContent: () => assert.fail('old workspace work must not touch the new account') };
  editor.mobileBack();
  await editor.saveQueue;
  service.offlineSync.generation = 'different-workspace-generation';
  gate.resolve();
  await service.localReminderRefreshQueue;
});
