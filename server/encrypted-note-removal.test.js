const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('encrypted lock removal is atomic and rejects legacy or stale writes', { timeout: 90000 }, async t => {
  const c = await import('../src/app/utils/note-crypto.ts');
  const fixture = await startFixture({ env: { KEPT_STORAGE_QUOTA_BYTES: String(4 * 1024 * 1024) } }); t.after(async () => { if (process.env.DEBUG_RESTORE) console.log(fixture.output); await fixture.close(); });
  let token;
  async function api(route, body, method = body ? 'POST' : 'GET', status = 200) {
    const response = await fetch(`${fixture.origin}/api${route}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, status, await response.clone().text());
    return response.json().catch(() => null);
  }
  await api('/setup/admin', { username: 'owner', password: 'safe-test-password' }, 'POST', 201);
  token = (await api('/auth/login', { username: 'owner', password: 'safe-test-password' })).token;
  const note = await api('/notes', { noteTitle: 'Private documents', noteBody: '<p>Important text</p>', checkBoxes: [], labels: [], images: [] }, 'POST', 201);
  const keys = await c.createNoteKeys('test passcode', 100000);
  const plainFiles = ['first private document', 'second private document'];
  const rows = [];
  for (const [index, text] of plainFiles.entries()) {
    const form = new FormData(); form.append('file', await c.sealFile(keys.dataKey, new Blob([text])), c.ENCRYPTED_FILE_NAME);
    const response = await fetch(`${fixture.origin}/api/notes/${note.id}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    assert.equal(response.status, 201, await response.clone().text()); rows.push(await response.json());
  }
  const content = { noteBody: '<p>Important text</p>', checkBoxes: [{ id: 1, data: 'Keep this', done: false }], images: [],
    files: Object.fromEntries(rows.map((row, i) => [row.syncId, { name: `${i}.txt`, type: 'text/plain', size: plainFiles[i].length, kind: 'attachment' }])) };
  const envelope = await c.sealNoteContent(keys, content);
  await api(`/notes/${note.id}`, { locked: true, lockHash: c.E2E_LOCK_MARKER, lockSalt: keys.kdf.salt, encryptedContent: envelope,
    noteBody: '', checkBoxes: [], images: [] }, 'PATCH', 204);
  const intact = async () => {
    const stored = await api(`/notes/${note.id}`);
    assert.equal(stored.locked, true); assert.equal(stored.encryptedContent, envelope);
    assert.equal((await c.openNoteContent(keys, stored.encryptedContent)).noteBody, content.noteBody);
    const attachments = await fixture.sql('SELECT * FROM note_attachments WHERE noteId = ?', [note.id]);
    assert.equal(attachments.length, 2);
    for (const [i, row] of rows.entries()) {
      const bytes = await fs.readFile(path.join(fixture.directory, 'attachments', row.storedFilename || attachments.find(a => a.syncId === row.syncId).storedFilename));
      assert.equal(await (await c.openFile(keys.dataKey, new Blob([bytes]))).text(), plainFiles[i]);
    }
  };
  const restored = { noteBody: content.noteBody, checkBoxes: content.checkBoxes, images: [],
    expectedEnvelopeHash: createHash('sha256').update(envelope).digest('hex'), restoredFileIds: rows.map(r => r.syncId),
    attachments: rows.map(row => ({ sourceSyncId: row.syncId })) };
  async function restore(data = restored, names = ['0.txt', '1.txt']) {
    const form = new FormData(); form.append('note', JSON.stringify(data));
    for (const [i, name] of names.entries()) form.append('files', new Blob([plainFiles[i]], { type: 'text/plain' }), name);
    return fetch(`${fixture.origin}/api/notes/${note.id}/remove-encryption`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  }
  await t.test('a missing replacement cannot supersede the key or delete a referenced file', async () => {
    const nextKeys = await c.createNoteKeys('new passcode', 100000, 2);
    const missing = await c.sealNoteContent(nextKeys, { noteBody: 'replacement', checkBoxes: [], files: {
      missing: { name: 'missing.txt', type: 'text/plain', size: 1, kind: 'attachment' } } });
    await api(`/notes/${note.id}`, { locked: true, lockSalt: nextKeys.kdf.salt, lockHash: c.E2E_LOCK_MARKER, encryptedContent: missing }, 'PATCH', 409);
    await api(`/notes/${note.id}/attachments/${rows[0].id}`, undefined, 'DELETE', 409);
    await intact();
  });
  await t.test('old PATCH, PUT and sync cannot clear the encrypted body', async () => {
    for (const method of ['PATCH', 'PUT']) await api(`/notes/${note.id}`, { locked: false, lockSalt: '', lockHash: '' }, method, 409);
    const result = await api('/sync/mutations', { protocolVersion: 2, mutations: [{ type: 'note.upsert', syncId: note.syncId,
      operationId: 'old-unlock', lww: { physicalMs: Date.now() + 1000, logical: 0, deviceId: 'old', operationId: 'old-unlock' },
      payload: { ...note, locked: false, lockSalt: '', lockHash: '' } }] });
    assert.equal(result.results[0].ok, false); assert.equal(result.results[0].status, 409);
    await intact();
  });
  await t.test('stale envelope and incomplete file manifests preserve everything', async () => {
    assert.equal((await restore({ ...restored, expectedEnvelopeHash: '0'.repeat(64) })).status, 409);
    assert.equal((await restore({ ...restored, restoredFileIds: [] })).status, 400);
    assert.equal((await restore(restored, ['0.txt'])).status, 400);
    await intact();
  });
  await t.test('a disallowed second upload never commits a partial restore', async () => {
    const response = await restore(restored, ['0.txt', 'bad.exe']);
    assert.ok(!response.ok); await intact();
  });
  await t.test('losing the connection during multipart restoration keeps the original', async () => {
    const boundary = 'kept-restore-interruption';
    const chunk = `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${JSON.stringify(restored)}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="0.txt"\r\nContent-Type: text/plain\r\n\r\n${plainFiles[0]}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="1.txt"\r\nContent-Type: text/plain\r\n\r\npartial`;
    await new Promise(resolve => {
      const request = require('node:http').request(`${fixture.origin}/api/notes/${note.id}/remove-encryption`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(chunk) + 10000 } });
      request.on('error', resolve);
      request.write(chunk);
      setTimeout(() => request.destroy(new Error('Simulated lost connection')), 50);
    });
    await intact();
  });
  await t.test('a storage-full upload leaves the encrypted note and files recoverable', async () => {
    const form = new FormData(); form.append('note', JSON.stringify(restored));
    form.append('files', new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'text/plain' }), 'large.txt');
    const response = await fetch(`${fixture.origin}/api/notes/${note.id}/remove-encryption`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    assert.equal(response.status, 507, await response.clone().text()); await intact();
  });
  await t.test('a database failure rolls back files and note and permits retry after restart', async () => {
    await fixture.sql(`CREATE TRIGGER refuse_unlock BEFORE UPDATE OF locked ON notes WHEN NEW.locked = 0 BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END`);
    assert.equal((await restore()).status, 409); await intact();
    await fixture.sql('DROP TRIGGER refuse_unlock');
    await fixture.restart(); await intact();
  });
  await t.test('successful retry restores all bytes before discarding the envelope', async () => {
    const response = await restore(); assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json(); assert.equal(saved.locked, false); assert.equal(saved.encryptedContent, '');
    assert.equal(saved.noteBody, content.noteBody); assert.deepEqual(saved.checkBoxes, content.checkBoxes);
    assert.equal(saved.attachments.length, 2);
    for (const row of saved.attachments) {
      const download = await fetch(`${fixture.origin}/api/attachments/${row.id}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(download.status, 200); assert.equal(await download.text(), plainFiles[Number(row.originalName[0])]);
    }
    assert.equal((await restore()).status, 409, 'a repeated operation cannot destroy the restored note');
    assert.equal((await api(`/notes/${note.id}`)).noteBody, content.noteBody);
  });
});

test('device-to-server migration preserves references inside encrypted file envelopes', { timeout: 60000 }, async t => {
  const c = await import('../src/app/utils/note-crypto.ts');
  const fixture = await startFixture(); t.after(() => fixture.close());
  let token;
  async function api(route, body, method = 'POST', status = 200) {
    const response = await fetch(`${fixture.origin}/api${route}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal(response.status, status, await response.clone().text()); return response.json();
  }
  await api('/setup/admin', { username: 'migrate', password: 'migration-test-password' }, 'POST', 201);
  token = (await api('/auth/login', { username: 'migrate', password: 'migration-test-password' })).token;
  const keys = await c.createNoteKeys('migration password', 100000);
  const fileId = 'attachment-local-encrypted';
  const bytes = Buffer.from(await (await c.sealFile(keys.dataKey, new Blob(['PRIVATE MIGRATED FILE']))).arrayBuffer());
  const envelope = await c.sealNoteContent(keys, { noteBody: 'Private migrated text', checkBoxes: [],
    files: { [fileId]: { name: 'original.txt', type: 'text/plain', size: 21, kind: 'attachment' } } });
  const note = { id: 1, syncId: 'local-secret', noteTitle: 'Migrated secret', noteBody: '', checkBoxes: [], labels: [], images: [],
    locked: true, lockSalt: keys.kdf.salt, lockHash: c.E2E_LOCK_MARKER, encryptedContent: envelope };
  const attachment = { id: 2, syncId: fileId, noteId: 1, originalName: c.ENCRYPTED_FILE_NAME, fileSize: bytes.length, mimeType: c.ENCRYPTED_FILE_TYPE };
  const job = await api('/workspace-import', { sourceId: 'encrypted-device', generation: 'first' });
  const manifest = [];
  for (const [type, value] of [['note', note], ['attachment', attachment]]) {
    const payload = { type, value }, digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const key = `record:${type}:${value.syncId}`;
    await api(`/workspace-import/${job.id}/items`, { key, kind: 'record', payload, digest }, 'PUT'); manifest.push({ key, digest });
  }
  const key = `blob:attachment:${fileId}`, digest = createHash('sha256').update(bytes).digest('hex');
  await api(`/workspace-import/${job.id}/items`, { key, kind: 'blob', digest, offset: 0, base64: bytes.toString('base64'),
    payload: { blobKey: `attachment:${fileId}`, size: bytes.length, mimeType: c.ENCRYPTED_FILE_TYPE, name: c.ENCRYPTED_FILE_NAME } }, 'PUT');
  manifest.push({ key, digest });
  const result = await api(`/workspace-import/${job.id}/finalize`, { items: manifest });
  const id = result.mappings.notes[1].id;
  const saved = await (await fetch(`${fixture.origin}/api/notes/${id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(saved.encryptedContent, envelope);
  assert.equal(saved.attachments[0].syncId, fileId);
  const row = (await fixture.sql('SELECT * FROM note_attachments WHERE noteId = ?', [id]))[0];
  const blob = new Blob([await fs.readFile(path.join(fixture.directory, 'attachments', row.storedFilename))]);
  assert.equal(await (await c.openFile(keys.dataKey, blob)).text(), 'PRIVATE MIGRATED FILE');
});
