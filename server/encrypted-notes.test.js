// node --test server/encrypted-notes.test.js
// Issue #27: a note locked with the E2E marker is stored only as an
// AES-GCM envelope; the server must never store or hand out its plaintext.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto: crypto } = require('node:crypto');
const { startFixture } = require('../test-support/session-fixture.cjs');

const MARKER = 'e2e:v1';
const b64 = bytes => Buffer.from(bytes).toString('base64url');
// Same envelope format as src/app/utils/note-crypto.ts, with fewer
// iterations for speed. The server can't check the wrapped key or the
// ciphertext, only their shape.
// A collaborator re-seals with the note's existing key, so pass its salt.
async function seal(passcode, content, images = [], files = [], { salt = b64(crypto.getRandomValues(new Uint8Array(16))), epoch = 1 } = {}) {
  const iterations = 100000;
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('kept-note-v1') }, key,
    new TextEncoder().encode(JSON.stringify(content)));
  const wrap = { iv: b64(crypto.getRandomValues(new Uint8Array(12))), ct: b64(crypto.getRandomValues(new Uint8Array(48))) };
  return { salt, envelope: JSON.stringify({ v: 1, alg: 'AES-GCM', kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt }, wrap, epoch,
    iv: b64(iv), ct: b64(new Uint8Array(ct)), images, files }) };
}

test('encrypted notes keep only ciphertext on the server', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const password = 'encrypted-notes-password';
  async function api(path, body, token, method = body === undefined ? 'GET' : 'POST', status = 200) {
    const response = await fetch(`${fixture.origin}/api${path}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    return status === 204 ? null : response.json().catch(() => null);
  }
  let sequence = 0;
  async function mutate(type, syncId, payload, token) {
    const operationId = `e2e-test-${++sequence}`;
    return (await api('/sync/mutations', { protocolVersion: 2, mutations: [{ type, syncId, payload, operationId,
      lww: { physicalMs: Date.now() + sequence, logical: sequence, deviceId: 'e2e-test', operationId } }] }, token)).results[0];
  }
  const secretsInDatabase = async secret => {
    const tables = [['notes', 'noteBody || checkBoxes || encryptedContent'], ['sync_changes', 'payload'], ['workspace_operations', 'result'], ['reminders', 'COALESCE(body, \'\')']];
    let hits = 0;
    for (const [table, column] of tables) hits += (await fixture.sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`, [`%${secret}%`]))[0].n;
    return hits;
  };

  await api('/setup/admin', { username: 'owner', password }, undefined, 'POST', 201);
  const owner = (await api('/auth/login', { username: 'owner', password })).token;
  const collabUser = await api('/users', { username: 'collab', password }, owner, 'POST', 201);
  const collab = (await api('/auth/login', { username: 'collab', password })).token;

  // An image the encrypted body uses, uploaded the normal way.
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'photo.jpg');
  const uploaded = await (await fetch(`${fixture.origin}/api/uploads/images`, { method: 'POST', headers: { Authorization: `Bearer ${owner}` }, body: form })).json();
  const imageFile = uploaded.url.split('/').pop();

  // Created through sync so a receipt and change-feed snapshot hold plaintext.
  const created = await mutate('note.upsert', 'note-secret', { syncId: 'note-secret', noteTitle: 'Diary',
    noteBody: `<p>PLAINTEXT-SECRET</p><img src="/api/uploads/images/${imageFile}">`, checkBoxes: [], labels: [], images: [] }, owner);
  assert.equal(created.ok, true, JSON.stringify(created));
  const noteId = created.id;
  await api(`/notes/${noteId}/collaborators`, { userIds: [collabUser.id] }, owner, 'PUT');
  await api('/reminders', { noteId, dueAtUtc: new Date(Date.now() + 86400000).toISOString(), timezone: 'UTC', title: 'Diary', body: 'PLAINTEXT-SECRET' }, owner, 'POST', 201);
  assert.ok(await secretsInDatabase('PLAINTEXT-SECRET') > 0, 'precondition: plaintext exists before locking');

  const first = await seal('correct horse', { noteBody: `<p>PLAINTEXT-SECRET</p><img src="/api/uploads/images/${imageFile}">`, checkBoxes: [] }, [imageFile]);

  await t.test('locking stores the envelope and purges older plaintext copies', async () => {
    await api(`/notes/${noteId}`, { locked: true, lockSalt: first.salt, lockHash: MARKER, encryptedContent: first.envelope, noteBody: '', checkBoxes: [] }, owner, 'PATCH', 204);
    const stored = (await fixture.sql('SELECT noteBody, checkBoxes, encryptedContent, lockHash FROM notes WHERE id = ?', [noteId]))[0];
    assert.equal(stored.noteBody, '');
    assert.equal(stored.checkBoxes, '[]');
    assert.equal(stored.encryptedContent, first.envelope);
    assert.equal(stored.lockHash, MARKER);
    // Notes, the sync feed, operation receipts and reminder copies.
    assert.equal(await secretsInDatabase('PLAINTEXT-SECRET'), 0, 'no plaintext copy left in the database');
    const reminders = await api('/reminders', undefined, owner);
    assert.ok(reminders.every(reminder => !String(reminder.body || '').includes('PLAINTEXT-SECRET')), 'reminder API omits locked note content');
  });

  await t.test('readers get the envelope, never plaintext', async () => {
    for (const token of [owner, collab]) {
      const note = await api(`/notes/${noteId}`, undefined, token);
      assert.equal(note.noteBody, '');
      assert.equal(note.encryptedContent, first.envelope);
    }
  });

  await t.test('images used by the encrypted body stay linked and readable', async () => {
    await api(`/notes/${noteId}`, { bgColor: '#e8d7ff' }, owner, 'PATCH', 204);
    const links = await fixture.sql('SELECT noteId FROM note_images WHERE storedFilename = ?', [imageFile]);
    assert.deepEqual(links.map(row => row.noteId), [noteId]);
    assert.equal((await fetch(`${fixture.origin}/api/uploads/images/${imageFile}`, { headers: { Authorization: `Bearer ${collab}` } })).status, 200);
  });

  await t.test('plaintext writes to an encrypted note are refused, on REST and sync', async () => {
    await api(`/notes/${noteId}`, { noteTitle: 'Diary', noteBody: '<p>LEAKED</p>' }, owner, 'PUT', 400);
    await api(`/notes/${noteId}`, { checkBoxes: [{ id: 1, data: 'LEAKED', done: false }] }, collab, 'PATCH', 400);
    const viaSync = await mutate('note.upsert', 'note-secret', { syncId: 'note-secret', noteTitle: 'Diary', noteBody: '<p>LEAKED</p>', locked: true, lockSalt: first.salt, lockHash: MARKER, checkBoxes: [], labels: [] }, owner);
    assert.equal(viaSync.ok, false);
    assert.equal(viaSync.status, 400);
    await api(`/notes/${noteId}`, { encryptedContent: '{"v":1}' }, owner, 'PATCH', 400);
    assert.equal(await secretsInDatabase('LEAKED'), 0);
    assert.equal((await fixture.sql('SELECT encryptedContent FROM notes WHERE id = ?', [noteId]))[0].encryptedContent, first.envelope);
  });

  await t.test('a collaborator can save new ciphertext but cannot change the lock', async () => {
    const edited = await seal('correct horse', { noteBody: '<p>edited by collab</p>', checkBoxes: [] }, [], [], { salt: first.salt });
    await api(`/notes/${noteId}`, { encryptedContent: edited.envelope, noteBody: '', locked: false, lockHash: '' }, collab, 'PATCH', 204);
    const stored = (await fixture.sql('SELECT encryptedContent, locked, lockHash FROM notes WHERE id = ?', [noteId]))[0];
    assert.equal(stored.encryptedContent, edited.envelope);
    assert.equal(stored.locked, 1);
    assert.equal(stored.lockHash, MARKER);
  });

  await t.test('a passcode change moves to a new key; saves under the old one are refused', async () => {
    // The owner changes the passcode: new salt, next key epoch.
    const rotated = await seal('new horse', { noteBody: '<p>after rotation</p>', checkBoxes: [] }, [], [], { epoch: 2 });
    await api(`/notes/${noteId}`, { lockSalt: rotated.salt, lockHash: MARKER, encryptedContent: rotated.envelope }, owner, 'PATCH', 204);
    // A collaborator still holding the old key.
    const staleCollab = await seal('correct horse', { noteBody: '<p>STALE</p>', checkBoxes: [] }, [], [], { salt: first.salt });
    const refused = await api(`/notes/${noteId}`, { encryptedContent: staleCollab.envelope }, collab, 'PATCH', 400);
    assert.match(refused.error, /passcode was changed/);
    // Another of the owner's devices, sending its whole stale copy.
    await api(`/notes/${noteId}`, { lockSalt: first.salt, lockHash: MARKER, encryptedContent: staleCollab.envelope }, owner, 'PATCH', 400);
    const viaSync = await mutate('note.upsert', 'note-secret', { syncId: 'note-secret', noteTitle: 'Diary', locked: true, lockSalt: first.salt,
      lockHash: MARKER, encryptedContent: staleCollab.envelope, noteBody: '', checkBoxes: [], labels: [] }, owner);
    assert.equal(viaSync.ok, false);
    assert.equal(viaSync.status, 400, 'stale saves are permanent refusals, not retried forever');
    // A collaborator can't rotate the key themselves.
    const takeover = await seal('collab horse', { noteBody: '<p>mine now</p>', checkBoxes: [] }, [], [], { epoch: 3 });
    await api(`/notes/${noteId}`, { lockSalt: takeover.salt, encryptedContent: takeover.envelope }, collab, 'PATCH', 400);
    assert.equal((await fixture.sql('SELECT encryptedContent FROM notes WHERE id = ?', [noteId]))[0].encryptedContent, rotated.envelope);
    assert.equal(await secretsInDatabase('STALE'), 0);
    // With the new key, the collaborator's edit goes through.
    const current = await seal('new horse', { noteBody: '<p>collab with new key</p>', checkBoxes: [] }, [], [], { salt: rotated.salt, epoch: 2 });
    await api(`/notes/${noteId}`, { encryptedContent: current.envelope }, collab, 'PATCH', 204);
  });

  await t.test('encrypted notes cannot be merged or opened by external apps', async () => {
    const other = await api('/notes', { noteTitle: 'Other', noteBody: '<p>x</p>', labels: [], images: [], checkBoxes: [] }, owner, 'POST', 201);
    await api('/notes/merge', { orderedIds: [noteId, other.id] }, owner, 'POST', 409);
    const mcpToken = (await api('/users/me/mcp-access/enable', {}, owner, 'POST', 201)).accessToken;
    await api('/users/me/external-access/capabilities', { allowLockedNotes: true }, owner, 'PATCH');
    const refused = await api(`/mcp/locked-notes/${noteId}/unlock`, {}, mcpToken, 'POST', 409);
    assert.equal(refused.code, 'NOTE_ENCRYPTED');
  });

  await t.test('a clone stays encrypted', async () => {
    const { id } = await api(`/notes/${noteId}/clone`, {}, owner, 'POST', 201);
    const clone = (await fixture.sql('SELECT noteBody, encryptedContent, lockHash FROM notes WHERE id = ?', [id]))[0];
    assert.equal(clone.noteBody, '');
    assert.equal(clone.lockHash, MARKER);
    assert.ok(clone.encryptedContent.length > 0);
  });

  await t.test('removing the lock stores the content in the clear again', async () => {
    const current = await api(`/notes/${noteId}`, undefined, owner);
    const form = new FormData();
    form.append('note', JSON.stringify({ expectedEnvelopeHash: require('node:crypto').createHash('sha256').update(current.encryptedContent).digest('hex'),
      noteBody: '<p>back in the clear</p>', checkBoxes: [], images: [], restoredFileIds: [], attachments: [] }));
    const removed = await fetch(`${fixture.origin}/api/notes/${noteId}/remove-encryption`, { method: 'POST', headers: { Authorization: `Bearer ${owner}` }, body: form });
    assert.equal(removed.status, 200, await removed.clone().text());
    const stored = (await fixture.sql('SELECT noteBody, encryptedContent, locked FROM notes WHERE id = ?', [noteId]))[0];
    assert.equal(stored.locked, 0);
    assert.equal(stored.encryptedContent, '');
    assert.match(stored.noteBody, /back in the clear/);
  });

  await t.test('encrypted notes take only encrypted files, kept while referenced', async () => {
    const files = await api('/notes', { noteTitle: 'Files', noteBody: '<p>x</p>', labels: [], images: [], checkBoxes: [] }, owner, 'POST', 201);
    const upload = async (name, type, bytes = 'KEF1 sealed bytes') => {
      const body = new FormData();
      body.append('file', new Blob([bytes], { type }), name);
      const response = await fetch(`${fixture.origin}/api/notes/${files.id}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${owner}` }, body });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    // Encrypted copies can be uploaded before the lock is saved.
    const keep = await upload('encrypted.keptenc', 'application/octet-stream');
    const stale = await upload('encrypted.keptenc', 'application/octet-stream');
    assert.equal(keep.status, 201, JSON.stringify(keep.body));
    const sealed = await seal('pw', { noteBody: '<img src="kept://file/x">', checkBoxes: [] }, [], [keep.body.syncId]);
    await api(`/notes/${files.id}`, { locked: true, lockSalt: sealed.salt, lockHash: MARKER, encryptedContent: sealed.envelope }, owner, 'PATCH', 204);
    assert.equal((await upload('notes.txt', 'text/plain', 'plain secret')).status, 409, 'no clear files on an encrypted note');
    assert.equal((await upload('encrypted.keptenc', 'application/octet-stream')).status, 201);
    await api(`/notes/${files.id}`, { noteTitle: 'Plain images' , images: [{ id: 'i', dataUrl: '/api/uploads/images/1700000000000-0123456789abcdef01234567.png' }] }, owner, 'PATCH', 400);
    // An unreferenced encrypted file older than the grace period is removed
    // on the next write; referenced and recent ones stay.
    await fixture.sql("UPDATE note_attachments SET uploadedAt = '2000-01-01T00:00:00.000Z' WHERE syncId IN (?, ?)", [keep.body.syncId, stale.body.syncId]);
    await api(`/notes/${files.id}`, { bgColor: '#ffffff' }, owner, 'PATCH', 204);
    const left = (await fixture.sql('SELECT syncId FROM note_attachments WHERE noteId = ?', [files.id])).map(row => row.syncId);
    assert.ok(left.includes(keep.body.syncId), 'referenced file kept');
    assert.ok(!left.includes(stale.body.syncId), 'stale unreferenced file removed');
    assert.equal(left.length, 2, 'the recent upload is still within its grace period');
    // The copy couldn't refer to the original's files.
    await api(`/notes/${files.id}/clone`, {}, owner, 'POST', 409);
  });

  await t.test('legacy passcode locks keep working unchanged', async () => {
    const legacy = await api('/notes', { noteTitle: 'Old lock', noteBody: '<p>legacy body</p>', locked: true, lockSalt: 'salt', lockHash: 'pbkdf2:abc', labels: [], images: [], checkBoxes: [] }, owner, 'POST', 201);
    const stored = (await fixture.sql('SELECT noteBody, encryptedContent FROM notes WHERE id = ?', [legacy.id]))[0];
    assert.match(stored.noteBody, /legacy body/);
    assert.equal(stored.encryptedContent, '');
  });
});
