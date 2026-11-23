const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { IDBObjectStore } = require('fake-indexeddb');
const { createStore } = require('../test-support/workspace-store.cjs');
function loadService(file = 'src/app/services/notes.service.ts', name = 'NotesService') {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console, File, Blob, Date, crypto: globalThis.crypto, TextEncoder, FormData, require(id) {
    if (id === '@angular/core') return { Injectable: () => value => value };
    if (id === '@capacitor/core') return { registerPlugin: () => ({}) };
    if (id === 'rxjs') return require('rxjs');
    if (id.endsWith('/uuid')) return { createUuid: () => globalThis.crypto.randomUUID() };
    if (id.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
    return {};
  } });
  return exports[name];
}
const Notes = loadService();
const Sync = loadService('src/app/services/offline-sync.service.ts', 'OfflineSyncService');
test('device-only restore commits all attachment bytes with the note or retains the original on failure', async t => {
  const store = createStore(); t.after(async () => (await store.open()).close());
  const workspace = { id: 'device', partition: 'local:device', mode: 'local', generation: 'first', status: 'active',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextId: 2, revision: 0,
    preferences: { theme: 'light', followSystemTheme: true, showPastReminders: false } };
  await store.saveWorkspace(workspace);
  const note = { id: 1, syncId: 'secret', noteTitle: 'Private', noteBody: '', checkBoxes: [], locked: true,
    encryptedContent: 'recoverable-envelope', lockSalt: 'salt', lockHash: 'e2e:v1', images: [], attachments: [] };
  await store.putNote(workspace.partition, note);
  const service = Object.assign(Object.create(Notes.prototype), { auth: { isLocal: true }, offlineStore: store,
    offlineSync: { partition: workspace.partition, commit: (...args) => store.commitMutation(workspace, ...args) }, mergeNoteIntoList: () => {} });
  const files = ['first.txt', 'second.txt'].map(name => ({ sourceSyncId: name, file: new File([name], name, { type: 'text/plain' }) }));
  const fields = { locked: false, lockSalt: '', lockHash: '', encryptedContent: '', noteBody: 'Restored text', checkBoxes: [], images: [] };
  const put = IDBObjectStore.prototype.put;
  let count = 0;
  IDBObjectStore.prototype.put = function(...args) {
    if (this.name === 'blobs' && ++count === 2) throw new Error('QuotaExceededError');
    return put.apply(this, args);
  };
  try { await assert.rejects(service.removeEncryptedLock(note, fields, files), /QuotaExceeded/); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await store.getNote(workspace.partition, note.id)).encryptedContent, note.encryptedContent);
  assert.equal((await store.listResources('attachment', workspace.partition)).length, 0, 'no partial file metadata');
  const database = await store.open();
  assert.equal(await store.request(database.transaction('blobs').objectStore('blobs').count()), 0, 'first file bytes rolled back too');
  await service.removeEncryptedLock(note, fields, files);
  const saved = await store.getNote(workspace.partition, note.id);
  assert.equal(saved.locked, false); assert.equal(saved.encryptedContent, ''); assert.equal(saved.noteBody, 'Restored text');
  assert.equal(saved.attachments.length, 2);
  for (const row of saved.attachments) assert.equal(await (await store.getBlob(workspace.partition, `attachment:${row.syncId}`)).text(), row.originalName);
});

test('connected restoration waits for queued edits rather than clearing an unavailable server copy', async () => {
  let contacted = false;
  const service = Object.assign(Object.create(Notes.prototype), { auth: { isLocal: false },
    offlineSync: { syncNow: async () => {}, pendingCount$: { value: 1 }, state$: { value: 'offline' }, isConnectionDegraded: () => true },
    http: { post: () => { contacted = true; } } });
  await assert.rejects(service.removeEncryptedLock({ id: 1 }, {}, []), /Connect to your server/);
  assert.equal(contacted, false);
});

for (const blocked of [false, true]) test(`encrypted replacements precede the key change; quota block=${blocked}`, async () => {
  let entries = [
    { operationId: 'replace', type: 'note.upsert', syncId: 'note', payload: { lockHash: 'e2e:v1', encryptedContent: JSON.stringify({ files: ['replacement'] }) } },
    { operationId: 'delete', type: 'attachment.delete', syncId: 'old', payload: { noteSyncId: 'note' } },
    { operationId: 'file', type: 'attachment.upsert', syncId: 'replacement', payload: { noteSyncId: 'note' } },
    { operationId: 'unrelated', type: 'note.upsert', syncId: 'another', payload: { noteBody: 'Other text still saves' } }
  ];
  const calls = [];
  const sync = Object.assign(Object.create(Sync.prototype), { currentPartition: 'test', activeContext: { workspace: { partition: 'test' } },
    store: { listOutbox: async () => entries }, storageBlocked$: { next: () => {} }, requestHeaders: () => ({}),
    flushAttachmentUploads: async batch => {
      calls.push(['files', batch.map(e => e.operationId)]);
      if (!blocked) entries = entries.filter(e => !batch.includes(e));
    },
    flushMutations: async batch => {
      calls.push(['notes', batch.map(e => e.operationId)]);
      if (!blocked) assert.equal(entries.some(e => e.operationId === 'file'), false, 'uploads acknowledged before the key change');
      entries = entries.filter(e => !batch.includes(e));
    } });
  await sync.flushOutbox();
  assert.deepEqual(calls[0], ['files', ['file']]);
  assert.equal(calls.filter(call => call[0] === 'files').length, 1, 'blocked files are not retried twice in one pass');
  const sent = calls.filter(call => call[0] === 'notes').flatMap(call => call[1]);
  assert.ok(sent.includes('unrelated'));
  assert.equal(sent.includes('replace'), !blocked);
  assert.equal(sent.includes('delete'), !blocked, 'the recovery copy stays until replacement files are safe');
});

test('locking retires old image cache bytes without removing a readable copy used by another note', async t => {
  const store = createStore(); t.after(async () => (await store.open()).close());
  const workspace = await store.ensureServerWorkspace('encrypted-image-cache');
  const source = '/api/uploads/images/1700000000000-0123456789abcdef01234567.png';
  const note = { id: 1, syncId: 'encrypted', locked: true, encryptedContent: 'envelope', noteBody: '', images: [] };
  await store.putNote(workspace.partition, note);
  const service = Object.assign(Object.create(Notes.prototype), { offlineStore: store, offlineSync: { partition: workspace.partition } });
  await store.putBlob(workspace.partition, `media:${source}`, new Blob(['OLD PLAINTEXT IMAGE']));
  await service.retirePlaintextImageCache(note, [source]);
  assert.equal(await store.getBlob(workspace.partition, `media:${source}`), undefined);
  await store.putNote(workspace.partition, { id: 2, syncId: 'readable-copy', noteBody: `<img src="${source}">` });
  await store.putBlob(workspace.partition, `media:${source}`, new Blob(['INTENTIONAL READABLE COPY']));
  await service.retirePlaintextImageCache(note, [source]);
  assert.equal(await (await store.getBlob(workspace.partition, `media:${source}`)).text(), 'INTENTIONAL READABLE COPY');
});
