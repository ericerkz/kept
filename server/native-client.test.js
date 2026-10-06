const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { initNativeClientSchema, occurrenceId } = require('./native-client');

async function migrationTest() {
  assert.equal(occurrenceId({ syncId: 'r', dueAtUtc: '2030-01-01T09:00:00Z', scheduleVersion: 3 }), 'r@2030-01-01T09:00:00.000Z#v3');
  const db = new sqlite3.Database(':memory:');
  const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
  const get = (sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
  const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
  try {
    await run('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    await run('CREATE TABLE notes (id INTEGER PRIMARY KEY, noteTitle TEXT)');
    await run(`CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, noteId INTEGER UNIQUE REFERENCES notes(id),
      userId INTEGER, syncId TEXT, dueAtUtc TEXT, repeatRule TEXT, timezone TEXT, status TEXT, gcalEventId TEXT)`);
    await run("INSERT INTO users VALUES (1), (2)");
    await run("INSERT INTO notes VALUES (1, 'Legacy')");
    await run("INSERT INTO reminders VALUES (9, 1, 1, 'stable-id', '2030-01-01T09:00:00Z', NULL, 'UTC', 'pending', 'calendar-id')");
    await initNativeClientSchema({ run, get, all });
    await initNativeClientSchema({ run, get, all });
    const original = await get('SELECT * FROM reminders WHERE id = 9');
    assert.equal(original.syncId, 'stable-id');
    assert.equal(original.gcalEventId, 'calendar-id');
    assert.equal(original.scheduleAnchorAtUtc, '2030-01-01T09:00:00Z');
    assert.equal(original.scheduleVersion, 1);
    await run("UPDATE reminders SET dueAtUtc = '2030-01-02T09:00:00Z' WHERE id = 9");
    const advanced = await get('SELECT * FROM reminders WHERE id = 9');
    assert.equal(advanced.scheduleVersion, 1, 'cursor advancement is not a schedule-definition edit');
    assert.equal(advanced.scheduleAnchorAtUtc, '2030-01-01T09:00:00Z');
    await run("INSERT INTO reminders (noteId, userId, syncId) VALUES (1, 2, 'second-user')");
    assert.equal((await get('SELECT COUNT(*) AS count FROM reminders')).count, 2);
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
}

async function integrationTest() {
  const directory = mkdtempSync(path.join(tmpdir(), 'kept-native-test-'));
  const dataDirectory = path.join(directory, 'data');
  const port = 14000 + Math.floor(Math.random() * 10000);
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/api`;
  let output = '';
  const serverEnv = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDirectory,
    SQLITE_PATH: path.join(dataDirectory, 'test.sqlite'),
    UPLOAD_DIR: path.join(dataDirectory, 'uploads'),
    ATTACHMENT_DIR: path.join(dataDirectory, 'attachments'),
    TAKEOUT_TMP_DIR: path.join(dataDirectory, 'imports', 'tmp'),
    KEPT_TEST_MODE: '1'
  };
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: path.join(__dirname, '..'), env: serverEnv, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });

  const stopServer = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  };
  const waitForServer = async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(base + '/setup/status');
        if (response.ok) return;
      } catch {}
      if (attempt > 100 || child.exitCode !== null) throw new Error(output || 'Server did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const request = async (route, token, body, method = body ? 'POST' : 'GET', expectedStatus = null) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const responseText = await response.clone().text();
    if (expectedStatus !== null) assert.equal(response.status, expectedStatus, `${route}: ${responseText}`);
    else assert.ok(response.ok, `${route}: ${response.status} ${responseText}`);
    return response.status === 204 ? null : response.json();
  };

  try {
    await waitForServer();
    await request('/setup/admin', null, { username: 'owner', password: 'test-password-123', displayName: 'Owner' });
    const owner = await request('/auth/login', null, { username: 'owner', password: 'test-password-123' });
    await request('/users', owner.token, { username: 'editor', password: 'test-password-456', displayName: 'Editor' });
    const editor = await request('/auth/login', null, { username: 'editor', password: 'test-password-456' });

    const capabilities = await request('/client/capabilities', owner.token);
    assert.equal(capabilities.noteRevisions, false);
    assert.equal(capabilities.personalReminders, true);
    assert.equal(capabilities.reminderOccurrences, true);
    assert.equal(capabilities.idempotentUploads, true);

    const uploadImage = async (bytes, operationId = 'native-image-retry', expectedStatus = null) => {
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: 'image/png' }), 'pixel.png');
      form.append('operationId', operationId);
      const response = await fetch(base + '/uploads/images', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form });
      if (expectedStatus !== null) assert.equal(response.status, expectedStatus, `image upload: ${await response.clone().text()}`);
      else assert.ok(response.ok, `image upload: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64');
    const firstImage = await uploadImage(imageBytes);
    const retryImage = await uploadImage(imageBytes);
    assert.equal(retryImage.url, firstImage.url, 'image retry must reuse the accepted upload');
    assert.ok((await uploadImage(Buffer.from('different-image-bytes'), 'native-image-retry', 409)).error);

    const note = await request('/notes', owner.token, {
      syncId: 'native-shared', noteTitle: 'Original', noteBody: '<b>Rich</b>', checkBoxes: [], images: [], labels: [],
      futureMetadata: { schema: 7, flags: ['keep-me'] }, clientExtension: 'preserved'
    });
    assert.deepEqual(note.futureMetadata, { schema: 7, flags: ['keep-me'] });
    const fetched = await request(`/notes/${note.id}`, owner.token);
    const { futureMetadata: _futureMetadata, clientExtension: _clientExtension, ...oldClientPayload } = fetched;
    const mutate = (token, mutations) => request('/sync/mutations', token, { mutations });
    const olderClientSave = await mutate(owner.token, [{ type: 'note.upsert', syncId: note.syncId, payload: oldClientPayload }]);
    assert.equal(olderClientSave.results[0].ok, true);
    const preserved = await request(`/notes/${note.id}`, owner.token);
    assert.deepEqual(preserved.futureMetadata, { schema: 7, flags: ['keep-me'] });
    assert.equal(preserved.clientExtension, 'preserved');

    const uploadAttachment = async (content, noteId = note.id, expectedStatus = null) => {
      const form = new FormData();
      form.append('file', new Blob([content], { type: 'text/plain' }), 'replay.txt');
      form.append('syncId', 'attachment-retry-stable');
      const response = await fetch(`${base}/notes/${noteId}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form });
      if (expectedStatus !== null) assert.equal(response.status, expectedStatus, `attachment upload: ${await response.clone().text()}`);
      else assert.ok(response.ok, `attachment upload: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    const firstAttachment = await uploadAttachment('first body');
    const retryAttachment = await uploadAttachment('first body');
    assert.equal(retryAttachment.id, firstAttachment.id, 'attachment retry must reuse its stable sync ID');
    assert.ok((await uploadAttachment('different body', note.id, 409)).error);
    const otherNote = await request('/notes', owner.token, { noteTitle: 'Different destination', noteBody: '', checkBoxes: [], images: [], labels: [] });
    assert.ok((await uploadAttachment('first body', otherNote.id, 409)).error);

    await request(`/notes/${note.id}/collaborators`, owner.token, { userIds: [editor.user.id] }, 'PUT');
    const due = new Date(Date.now() + 3600000).toISOString();
    const ownerReminder = await request('/reminders', owner.token, { noteId: note.id, dueAtUtc: due, timezone: 'UTC' });
    const editorReminder = await request('/reminders', editor.token, { noteId: note.id, dueAtUtc: due, timezone: 'UTC' });
    assert.notEqual(ownerReminder.id, editorReminder.id, 'collaborators get per-user reminders for the same note');
    const foreignPatch = await fetch(`${base}/reminders/${ownerReminder.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${editor.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed' })
    });
    assert.equal(foreignPatch.status, 404, 'another user cannot patch a personal reminder');

    const deterministicReminder = await request('/reminders', owner.token, {
      syncId: 'deterministic-daily', dueAtUtc: '2030-01-01T09:00:00.000Z', timezone: 'UTC', repeatRule: '{"type":"daily"}'
    });
    const tick = await request('/test/reminders/tick', owner.token, { now: '2030-01-01T10:00:00.000Z' });
    assert.ok(tick.dueCount >= 1, 'deterministic tick should process the synthetic reminder');
    const advancedReminder = (await request('/reminders', owner.token)).find(row => row.syncId === deterministicReminder.syncId);
    assert.equal(advancedReminder.dueAtUtc, '2030-01-02T09:00:00.000Z');
    assert.equal(advancedReminder.scheduleVersion, deterministicReminder.scheduleVersion);
    const occurrences = await request('/native/reminders/occurrences', owner.token);
    assert.ok(occurrences.some(row => row.occurrenceId === occurrenceId(deterministicReminder)));
  } finally {
    await stopServer();
    rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  await migrationTest();
  await integrationTest();
  console.log('Native client hardening tests passed.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
