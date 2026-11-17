const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { BehaviorSubject, Subject } = require('rxjs');
const { createStore } = require('../test-support/workspace-store.cjs');

function loadService(file, name) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console, require(id) {
    if (id === '@angular/core') return { Injectable: () => value => value };
    if (id === '@capacitor/core') return { registerPlugin: () => ({}) };
    if (id.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
    return {};
  } });
  return exports[name];
}

const Shared = loadService('src/app/services/shared.service.ts', 'SharedService');
const Notes = loadService('src/app/services/notes.service.ts', 'NotesService');
const Sync = loadService('src/app/services/offline-sync.service.ts', 'OfflineSyncService');

test('150 notes are trashed in one atomic write with durable sync entries and their content intact', async () => {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('bulk-trash');
  for (let i = 0; i < 150; i++) await store.commitMutation(workspace, 'note.upsert', `note-${i}`, {
    id: i + 1, noteTitle: `Note ${i}`, noteBody: '<b>Keep this content</b>', archived: true,
    checkBoxes: [{ id: 1, data: 'Keep this row', done: false }], images: [{ id: 'photo', dataUrl: '/photo.jpg' }]
  });
  const atomic = store.atomic.bind(store);
  let transactions = 0;
  store.atomic = (...args) => { transactions++; return atomic(...args); };
  const result = await store.trashNotes(workspace, Array.from({ length: 150 }, (_, i) => `note-${i}`), 1);
  assert.equal(transactions, 1);
  assert.equal(result.affected.length, 150);
  assert.equal(result.leftSharedCount, 0);
  const notes = await store.listNotes(workspace.partition);
  assert.equal(notes.length, 150);
  assert.ok(notes.every(note => note.trashed && !note.archived && note.noteBody === '<b>Keep this content</b>' && note.checkBoxes[0].data === 'Keep this row' && note.images.length === 1));
  const entries = await store.listOutbox(workspace.partition);
  assert.equal(entries.filter(entry => entry.payload.trashed).length, 150);
  assert.equal(new Set(entries.map(entry => entry.operationId)).size, entries.length);
  assert.ok(entries.filter(entry => entry.payload.trashed).every(entry => entry.type === 'note.upsert'));
});

test('shared notes are left, shared-binder notes are trashed, and personal organization stays private', async () => {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('bulk-sharing');
  await store.commitMutation(workspace, 'note.upsert', 'shared', { id: 1, ownerUserId: 2, noteBody: 'Shared content' });
  await store.commitMutation(workspace, 'reminder.upsert', 'reminder', { noteId: 1, noteSyncId: 'shared' });
  await store.commitMutation(workspace, 'note.upsert', 'binder', { id: 2, ownerUserId: 2, sharedBinder: { id: 3 },
    sharedOrganization: { labels: [], binder: 'Owner binder' }, labels: [{ name: 'Personal label' }], binder: 'Personal binder', noteBody: 'Binder content' });
  const result = await store.trashNotes(workspace, ['shared', 'binder', 'binder'], 1);
  assert.equal(result.leftSharedCount, 1);
  assert.equal(result.affected.length, 2);
  assert.equal((await store.listReminders(workspace.partition)).length, 0);
  const notes = await store.listNotes(workspace.partition);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].trashed, true);
  assert.equal(notes[0].binder, 'Personal binder');
  const entries = await store.listOutbox(workspace.partition);
  assert.equal(entries.filter(entry => entry.syncId === 'shared').length, 1);
  assert.equal(entries.find(entry => entry.syncId === 'shared').type, 'note.delete');
  const outgoing = entries.find(entry => entry.syncId === 'binder' && entry.payload.trashed).payload;
  assert.equal(outgoing.binder, undefined);
  assert.equal(outgoing.labels, undefined);
  assert.equal(outgoing.sharedOrganization, undefined);
});

test('a failed batch rolls back earlier notes and their queued mutations', async () => {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('bulk-rollback');
  await store.commitMutation(workspace, 'note.upsert', 'keep', { id: 1, noteBody: 'Keep me', trashed: false });
  const before = JSON.stringify(await store.listOutbox(workspace.partition));
  await assert.rejects(store.trashNotes(workspace, ['keep', 'missing'], 1));
  assert.equal((await store.listNotes(workspace.partition))[0].trashed, false);
  assert.equal(JSON.stringify(await store.listOutbox(workspace.partition)), before);
  await assert.rejects(store.trashNotes({ ...workspace, generation: 'obsolete' }, ['keep'], 1));
  assert.equal((await store.listNotes(workspace.partition))[0].trashed, false);
});

test('one cache notification and one sync attempt follow a successful batch; failed storage publishes nothing', async () => {
  const sync = Object.create(Sync.prototype);
  let notifications = 0, attempts = 0, pendingReads = 0;
  Object.assign(sync, { auth: { currentUser: { id: 7 }, isLocal: false },
    workspace: async () => ({ id: 'workspace' }),
    store: { trashNotes: async () => ({ affected: [], leftSharedCount: 0 }) },
    cacheChanged$: new Subject(), state$: new BehaviorSubject('saved'),
    readPending: async () => { pendingReads++; }, syncNow: async () => { attempts++; }
  });
  sync.cacheChanged$.subscribe(() => notifications++);
  await sync.trashNotes(['one', 'two']);
  assert.equal(notifications, 1);
  assert.equal(attempts, 1);
  assert.equal(pendingReads, 1);
  sync.store.trashNotes = async () => { throw new Error('Storage full'); };
  await assert.rejects(sync.trashNotes(['one']), /Storage full/);
  assert.equal(notifications, 1);
  assert.equal(sync.state$.value, 'error');
});

test('bulk selection uses one operation and stays selected on failure', async () => {
  const shared = Object.create(Shared.prototype);
  const ids = [1, 2, 3];
  let calls = 0;
  Object.assign(shared, { note: { all: ids.map(id => ({ id })) }, selectedNoteIds: new BehaviorSubject(ids),
    Notes: { trashMany: async selected => { calls++; assert.deepEqual(Array.from(selected), ids); return 0; } }
  });
  await shared.bulkTrashSelected();
  assert.equal(calls, 1);
  assert.equal(shared.selectedNoteIds.value.length, 0);
  shared.selectedNoteIds.next(ids);
  shared.Notes.trashMany = async () => { throw new Error('Could not save'); };
  await assert.rejects(shared.bulkTrashSelected(), /Could not save/);
  assert.deepEqual(shared.selectedNoteIds.value, ids);
});

test('reminders are suppressed together after the durable batch without per-note reloads', async () => {
  const notes = Object.create(Notes.prototype);
  let calls = 0;
  const affected = [{ id: 1, trashed: true }, { id: 2, trashed: true }];
  Object.assign(notes, { offlineSync: { writesLocally: true, partition: 'local', trashNotes: async ids => {
    assert.deepEqual(Array.from(ids), ['one', 'two']); return { affected, leftSharedCount: 1 };
  } }, offlineStore: { listNotes: async () => [{ id: 1, syncId: 'one' }, { id: 2, syncId: 'two' }] },
    reminders: { updateNoteLifecycle: value => { calls++; assert.equal(value, affected); } },
    load: () => assert.fail('The cache notification handles the one overview refresh')
  });
  assert.equal(await notes.trashMany([1, 2, 1]), 1);
  assert.equal(calls, 1);
});

test('older servers use at most four concurrent writes and wait for all workers before reporting failure', async () => {
  const notes = Object.create(Notes.prototype);
  let active = 0, maximum = 0, completed = 0;
  Object.assign(notes, { offlineSync: { writesLocally: false }, auth: { currentUser: { id: 1 } },
    cachedOrLoadedNote: async id => ({ id, ownerUserId: 1 }),
    updateKey: async (patch, id) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve));
      active--; completed++;
      if (id === 3) throw new Error('Denied');
    }
  });
  await assert.rejects(notes.trashMany(Array.from({ length: 20 }, (_, i) => i + 1)), /Denied/);
  assert.equal(completed, 20);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
});
