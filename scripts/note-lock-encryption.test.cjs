// node --test scripts/note-lock-encryption.test.cjs
// Issue #27: NoteLockService seals locked notes before they leave the editor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadLockService({ prompts = [], alerts = [] } = {}) {
  const storage = new Map();
  const sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const window = { prompt: () => prompts.shift() ?? null, alert: message => alerts.push(message) };
  const globals = { console, window, sessionStorage, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, Blob, File, Date, Promise, Map, Set, Error, Uint8Array, ArrayBuffer, JSON };
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true } }).outputText;
    vm.runInNewContext(source, { ...globals, exports, require(name) {
      if (name === '@angular/core') return { Injectable: () => target => target };
      if (name.endsWith('/i18n/messages')) return { uiText: key => key };
      if (name.endsWith('/utils/note-html')) return { createNoteHtmlContainer: () => ({ innerHTML: '', querySelectorAll: () => [] }), sanitizeNoteHtml: html => html };
      if (name.endsWith('/utils/note-images')) return {};
      if (name.endsWith('/utils/note-crypto')) return load(path.resolve('src/app/utils/note-crypto.ts'));
      if (name.startsWith('./') && name.endsWith('.service')) return {};
      throw new Error(`Unexpected import ${name}`);
    } }, { filename });
    return exports;
  }
  const { NoteLockService } = load(path.resolve('src/app/services/note-lock.service.ts'));
  const crypto = load(path.resolve('src/app/utils/note-crypto.ts'));
  // Only the URL canonicalisation of AuthService is used here.
  const auth = { canonicalImageHtml: html => html, canonicalImageUrl: url => url };
  const service = new NoteLockService({}, { partition: 'server:test', generation: 'g1' }, auth);
  return { service, crypto, prompts, alerts, files: load(path.resolve('src/app/services/encrypted-files.service.ts')).EncryptedFilesService, auth };
}

// Objects from the vm sandbox have that realm's prototypes; compare as data.
const data = value => JSON.parse(JSON.stringify(value));
const note = (extra = {}) => ({ id: 7, syncId: 'note-7', noteTitle: 'Diary', noteBody: '<p>secret body</p>',
  checkBoxes: [{ id: 1, data: 'buy milk', done: false }], labels: [], isCbox: false, pinned: false, bgColor: '', bgImage: '', archived: false, trashed: false, ...extra });

async function openWith(crypto, passcode, sealed) {
  const content = await crypto.openNoteContent(await crypto.unlockNoteKeys(passcode, sealed), sealed);
  return { noteBody: content.noteBody, checkBoxes: content.checkBoxes };
}

test('locking a note seals its full content and clears the plaintext', async () => {
  const { service, crypto } = loadLockService({ prompts: ['hunter22', 'hunter22'] });
  const plain = note();
  const fields = await service.createLockFields(plain);
  assert.equal(fields.lockHash, crypto.E2E_LOCK_MARKER);
  const sealed = await service.sealOutgoing(fields, plain);
  assert.equal(sealed.noteBody, '');
  assert.deepEqual(data(sealed.checkBoxes), []);
  assert.deepEqual(data(sealed.images), [], 'images travel inside the envelope');
  assert.doesNotMatch(sealed.encryptedContent, /secret|milk/);
  assert.deepEqual(data(await openWith(crypto, 'hunter22', sealed.encryptedContent)), { noteBody: plain.noteBody, checkBoxes: plain.checkBoxes });
});

test('edits are re-sealed, metadata-only writes and sealed payloads pass through', async () => {
  const { service, crypto } = loadLockService({ prompts: ['hunter22', 'hunter22'] });
  const plain = note();
  const fields = await service.createLockFields(plain);
  const stored = { ...plain, ...(await service.sealOutgoing(fields, plain)) };

  assert.deepEqual(data(await service.sealOutgoing({ bgColor: '#ffffff' }, stored)), { bgColor: '#ffffff' });

  const edited = await service.sealOutgoing({ ...service.withPlaintext(stored), noteBody: '<p>new text</p>' }, stored);
  assert.equal(edited.noteBody, '');
  assert.notEqual(edited.encryptedContent, stored.encryptedContent);
  assert.equal((await openWith(crypto, 'hunter22', edited.encryptedContent)).noteBody, '<p>new text</p>');

  // updateKey hands an already-sealed payload on to update(): don't re-seal it.
  assert.equal(await service.sealOutgoing(edited, stored), edited);

  // Emptying the note on purpose is an edit too, not a sealed payload.
  const emptied = await service.sealOutgoing({ noteBody: '', checkBoxes: [], encryptedContent: stored.encryptedContent }, stored);
  assert.notEqual(emptied.encryptedContent, stored.encryptedContent);
  assert.deepEqual(data(await openWith(crypto, 'hunter22', emptied.encryptedContent)), { noteBody: '', checkBoxes: [] });
});

test('content cannot be saved for an encrypted note that is not unlocked here', async () => {
  const owner = loadLockService({ prompts: ['pass1', 'pass1'] });
  const plain = note();
  const stored = { ...plain, ...(await owner.service.sealOutgoing(await owner.service.createLockFields(plain), plain)) };
  const other = loadLockService();
  await assert.rejects(other.service.sealOutgoing({ noteBody: '<p>typed elsewhere</p>' }, stored), /note_lock.unlock_to_save/);
  assert.deepEqual(data(await other.service.sealOutgoing({ pinned: true }, stored)), { pinned: true });
});

test('opening an encrypted note needs the right passcode and yields a decrypted copy', async () => {
  const owner = loadLockService({ prompts: ['open sesame', 'open sesame'] });
  const plain = note();
  const stored = { ...plain, ...(await owner.service.sealOutgoing(await owner.service.createLockFields(plain), plain)) };

  const reader = loadLockService({ prompts: ['wrong', 'open sesame'] });
  assert.equal(reader.service.isUnlocked(stored), false);
  assert.equal(await reader.service.ensureUnlocked(stored), false);
  assert.deepEqual(data(reader.alerts), ['note_lock.incorrect_passcode']);
  assert.equal(await reader.service.ensureUnlocked(stored), true);
  const copy = reader.service.withPlaintext(stored);
  assert.equal(copy.noteBody, plain.noteBody);
  assert.equal(stored.noteBody, '', 'the stored object is not modified');
  assert.equal(reader.service.lockPreviewHidden(stored), true, 'cards never show encrypted content');

  assert.equal(await reader.service.removeLockFields(stored), null, 'an encrypted note needs its files decrypted first');
  const plainContent = { noteBody: plain.noteBody, checkBoxes: plain.checkBoxes, images: [] };
  const removed = await reader.service.removeLockFields(stored, plainContent);
  assert.deepEqual(data(removed), { locked: false, lockSalt: '', lockHash: '', encryptedContent: '', noteBody: plain.noteBody, checkBoxes: plain.checkBoxes, images: [] });
  assert.equal(reader.service.isUnlocked(stored), true, 'preparing removal retains the key until persistence succeeds');
  reader.service.clearUnlocked(stored);
  assert.equal(reader.service.isUnlocked(stored), false);
});

test('a card preview is never sealed in place of the full note', async () => {
  const { service } = loadLockService({ prompts: ['p', 'p'] });
  await assert.rejects(service.createLockFields(note({ isCardPreview: true, noteBody: '<p>secret bo…</p>' })), /open_the_note_to_lock_it/);
});

test('opening a legacy lock does not silently upgrade its format', async () => {
  const { service, crypto } = loadLockService({ prompts: ['1234'] });
  const salt = 'legacy-salt';
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 150000, hash: 'SHA-256' },
    await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode('1234'), 'PBKDF2', false, ['deriveBits']), 256);
  const legacy = note({ locked: true, lockSalt: salt, lockHash: `pbkdf2:${Buffer.from(bits).toString('base64url')}` });
  assert.equal(await service.ensureUnlocked({ ...legacy, isCardPreview: true, noteBody: '' }), true);
  assert.equal(service.dataKey(legacy), null);
  assert.equal(legacy.lockHash.startsWith('pbkdf2:'), true);

});

test('changing the passcode rotates to a new key that the old passcode cannot reach', async () => {
  const { service, crypto } = loadLockService({ prompts: ['first', 'first', 'second', 'second'] });
  const plain = note();
  const stored = { ...plain, ...(await service.sealOutgoing(await service.createLockFields(plain), plain)) };
  const oldKey = service.dataKey(stored);
  const keys = await service.prepareKeyRotation(stored);
  assert.equal(keys.epoch, 2);
  assert.notEqual(keys.kdf.salt, stored.lockSalt);
  const fields = service.rotateKeys(stored, keys, { noteBody: plain.noteBody, checkBoxes: plain.checkBoxes, images: [], files: {} });
  assert.equal(fields.lockSalt, keys.kdf.salt);
  assert.notEqual(service.dataKey(stored), oldKey);
  const rotated = { ...stored, ...(await service.sealOutgoing(fields, stored)) };
  const envelope = crypto.parseNoteEnvelope(rotated.encryptedContent);
  assert.equal(envelope.epoch, 2);
  await assert.rejects(crypto.unlockNoteKeys('first', rotated.encryptedContent));
  // The old passcode with the old envelope yields only the old key.
  const leaked = await crypto.unlockNoteKeys('first', stored.encryptedContent);
  await assert.rejects(crypto.openNoteContent(leaked, rotated.encryptedContent));
  assert.equal((await openWith(crypto, 'second', rotated.encryptedContent)).noteBody, plain.noteBody);
  // A device still holding the old key notices.
  const stale = loadLockService({ prompts: ['first'] });
  assert.equal(await stale.service.ensureUnlocked(stored), true);
  assert.equal(stale.service.keyChanged(rotated), true);
  assert.equal(await stale.service.openExternal(rotated), null);
  assert.equal(service.keyChanged(rotated), false);
});

test('collaborators\' updates are decrypted for the open editor; a card preview is ignored', async () => {
  const { service } = loadLockService({ prompts: ['shared', 'shared'] });
  const plain = note();
  const stored = { ...plain, ...(await service.sealOutgoing(await service.createLockFields(plain), plain)) };
  // A collaborator unlocks the same note on another device and edits it.
  const collaborator = loadLockService({ prompts: ['shared'] });
  assert.equal(await collaborator.service.ensureUnlocked(stored), true);
  const other = { ...stored, ...(await collaborator.service.sealOutgoing({ noteBody: '<p>edited elsewhere</p>' }, stored)) };
  const opened = await service.openExternal(other);
  assert.equal(opened.noteBody, '<p>edited elsewhere</p>');
  assert.equal(await service.openExternal({ ...other, encryptedContent: undefined, isCardPreview: true }), null);
});

test('encrypted attachments appear as decrypted views linked to their stored rows', async () => {
  const { service } = loadLockService({ prompts: ['p1', 'p1'] });
  const plain = note();
  const stored = { ...plain, ...(await service.sealOutgoing(await service.createLockFields(plain), plain)) };
  service.rememberRow(stored, { id: 31, syncId: 'attachment-a', originalName: 'encrypted.keptenc', fileSize: 120, mimeType: 'application/octet-stream', uploadedAt: '2026-11-23' });
  service.recordFile(stored, 'attachment-a', { name: 'tax return.pdf', type: 'application/pdf', size: 92, kind: 'attachment' });
  service.recordFile(stored, 'attachment-img', { name: 'photo.jpg', type: 'image/jpeg', size: 4, kind: 'image' });
  assert.deepEqual(data(service.attachmentViews(stored)), [{ id: 31, syncId: 'attachment-a', noteId: 7, originalName: 'tax return.pdf',
    fileSize: 92, mimeType: 'application/pdf', uploadedAt: '2026-11-23', encrypted: true }]);
  const sealed = await service.sealOutgoing({ noteBody: '<img src="kept://file/attachment-img">' }, stored);
  const envelope = JSON.parse(sealed.encryptedContent);
  assert.deepEqual(envelope.files.sort(), ['attachment-a', 'attachment-img']);
  assert.doesNotMatch(sealed.encryptedContent, /tax return|photo\.jpg/);
});

test('failed file restoration retains the original key and ciphertext for a retry', async () => {
  const { service, crypto, files: Files, auth } = loadLockService({ prompts: ['retry', 'retry'] });
  const plain = note();
  const stored = { ...plain, ...(await service.sealOutgoing(await service.createLockFields(plain), plain)) };
  service.rememberRow(stored, { id: 12, syncId: 'protected-file', originalName: crypto.ENCRYPTED_FILE_NAME, fileSize: 64, mimeType: 'application/octet-stream' });
  service.recordFile(stored, 'protected-file', { name: 'original.txt', type: 'text/plain', size: 7, kind: 'attachment' });
  stored.encryptedContent = (await service.sealOutgoing({ checkBoxes: plain.checkBoxes }, stored)).encryptedContent;
  const originalKey = service.dataKey(stored);
  const sealedFile = await crypto.sealFile(originalKey, new Blob(['PRIVATE']));
  let fail = true, deleted = 0;
  const notes = { fetchAttachmentBlob: async () => sealedFile, removeEncryptedLock: async (_note, _fields, restored) => {
    assert.equal(restored[0].sourceSyncId, 'protected-file');
    assert.equal(await restored[0].file.text(), 'PRIVATE');
    if (fail) throw new Error('storage full');
  }, deleteAttachment: async () => { deleted++; } };
  const files = new Files(service, notes, auth);
  await assert.rejects(files.removeLock(stored), /storage full/);
  assert.equal(service.dataKey(stored), originalKey);
  assert.equal(service.content(stored).noteBody, plain.noteBody);
  assert.equal(deleted, 0, 'failure never deletes the recovery files');
  // Reloading still opens the saved original, independently of in-memory keys.
  assert.equal((await openWith(crypto, 'retry', stored.encryptedContent)).noteBody, plain.noteBody);
  fail = false;
  const result = await files.removeLock(stored);
  assert.equal(result.fields.noteBody, plain.noteBody);
  assert.equal(service.dataKey(stored), null, 'key is forgotten only after restoration commits');
});

test('a failed passcode save restores the in-memory key instead of stranding the old files', async () => {
  const { service, crypto, files: Files, auth } = loadLockService({ prompts: ['old', 'old', 'new', 'new'] });
  const plain = note();
  const stored = { ...plain, ...(await service.sealOutgoing(await service.createLockFields(plain), plain)) };
  const oldKey = service.dataKey(stored);
  const files = new Files(service, { updateKey: async () => { throw new Error('database unavailable'); } }, auth);
  await assert.rejects(files.changePasscode(stored), /database unavailable/);
  assert.equal(service.dataKey(stored), oldKey);
  const edit = await service.sealOutgoing({ noteBody: '<p>Still editable</p>' }, stored);
  assert.equal((await openWith(crypto, 'old', edit.encryptedContent)).noteBody, '<p>Still editable</p>');
  await assert.rejects(crypto.unlockNoteKeys('new', edit.encryptedContent));
});
