const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const WebSocket = require('ws');
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
    await run("UPDATE notes SET noteTitle = 'Web edit' WHERE id = 1");
    assert.equal((await get('SELECT revision FROM notes WHERE id = 1')).revision, 2);
  } finally { await new Promise(resolve => db.close(resolve)); }
}

async function integrationTest() {
  const regressionFailures = [];
  const verifyRegression = async (description, assertion) => {
    try { await assertion(); }
    catch (error) { regressionFailures.push(`${description}: ${error.message}`); }
  };
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
  const startServer = () => {
    const childProcess = spawn(process.execPath, ['server/server.js'], {
      cwd: path.join(__dirname, '..'), env: serverEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    childProcess.stdout.on('data', data => { output += data; });
    childProcess.stderr.on('data', data => { output += data; });
    return childProcess;
  };
  const stopServer = async process => {
    if (!process || process.exitCode !== null) return;
    process.kill('SIGTERM');
    await new Promise(resolve => process.exitCode !== null ? resolve() : process.once('exit', resolve));
  };
  const waitForServer = async process => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(base + '/setup/status');
        if (response.ok) return;
      } catch {}
      if (attempt > 100 || process.exitCode !== null) throw new Error(output || 'Server did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  let child = startServer();
  const request = async (route, token, body, method = body ? 'POST' : 'GET', expectedStatus = null) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const responseText = await response.clone().text();
    if (expectedStatus !== null) assert.equal(response.status, expectedStatus, `${route}: ${responseText}`);
    else assert.ok(response.ok, `${route}: ${response.status} ${responseText}`);
    return response.status === 204 ? null : response.json();
  };
  try {
    await waitForServer(child);
    await request('/setup/admin', null, { username: 'owner', password: 'test-password-123', displayName: 'Owner' });
    const owner = await request('/auth/login', null, { username: 'owner', password: 'test-password-123' });
    await request('/users', owner.token, { username: 'editor', password: 'test-password-456', displayName: 'Editor' });
    const editor = await request('/auth/login', null, { username: 'editor', password: 'test-password-456' });
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`, { headers: { Authorization: `Bearer ${owner.token}` } });
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Bearer-authenticated realtime socket did not open')); }, 3000);
      socket.once('open', () => { clearTimeout(timeout); socket.close(); resolve(); });
      socket.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    const capabilities = await request('/client/capabilities', owner.token);
    assert.equal(capabilities.personalReminders, true);
    assert.equal(capabilities.nativeProtocolVersion, 3);
    assert.equal(capabilities.reminderScheduleDefinitions, true);
    const imported = await request('/reminders/import', owner.token, { icsContent: [
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20300105T090000Z', 'SUMMARY:Fixture import', 'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n') });
    assert.equal(imported.imported, 1);
    const importedReminder = (await request('/reminders', owner.token)).find(row => row.title === 'Fixture import');
    assert.ok(importedReminder.syncId, 'calendar imports receive stable sync identities');
    assert.equal(importedReminder.scheduleVersion, 1);
    assert.equal(importedReminder.scheduleAnchorAtUtc, importedReminder.dueAtUtc);
    const uploadImage = async (bytes, expectedStatus = null) => {
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: 'image/png' }), 'pixel.png');
      form.append('operationId', 'native-image-retry');
      const response = await fetch(base + '/uploads/images', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form });
      if (expectedStatus !== null) assert.equal(response.status, expectedStatus, `image upload: ${await response.clone().text()}`);
      else assert.ok(response.ok, `image upload: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64');
    const firstImage = await uploadImage(imageBytes);
    const retryImage = await uploadImage(imageBytes);
    assert.equal(retryImage.url, firstImage.url, 'retry must reuse the accepted private-image upload');
    const changedImageContent = await uploadImage(Buffer.from('different-image-bytes'), 409);
    assert.ok(changedImageContent.error, 'an image operation ID cannot be reused for changed bytes');
    const original = await request('/notes', owner.token, {
      syncId: 'native-shared', noteTitle: 'Original', noteBody: '<b>Rich</b>', checkBoxes: [], images: [], labels: [],
      futureMetadata: { schema: 7, flags: ['keep-me'] }, clientExtension: 'preserved'
    });
    assert.deepEqual(original.futureMetadata, { schema: 7, flags: ['keep-me'] }, 'note creation returns unrecognized fields');
    assert.equal(original.clientExtension, 'preserved');
    const mutate = (token, mutations) => request('/sync/mutations', token, { mutations });
    const oldClientNote = await request(`/notes/${original.id}`, owner.token);
    const { futureMetadata: _futureMetadata, clientExtension: _clientExtension, ...oldClientPayload } = oldClientNote;
    const oldClientSave = await mutate(owner.token, [{ type: 'note.upsert', syncId: oldClientNote.syncId,
      baseRevision: oldClientNote.revision, operationId: 'old-client-omits-future-fields', payload: oldClientPayload }]);
    assert.equal(oldClientSave.results[0].ok, true);
    assert.deepEqual(oldClientSave.results[0].payload.futureMetadata, { schema: 7, flags: ['keep-me'] },
      'accepted mutation results carry the exact stored note snapshot');
    let compatibilityNote = await request(`/notes/${original.id}`, owner.token);
    assert.deepEqual(compatibilityNote.futureMetadata, { schema: 7, flags: ['keep-me'] }, 'sync from an older client retains omitted fields');
    assert.equal(compatibilityNote.clientExtension, 'preserved');
    await request(`/notes/${original.id}`, owner.token, { noteBody: '<b>Edited on web</b>' }, 'PATCH');
    compatibilityNote = await request(`/notes/${original.id}`, owner.token);
    assert.deepEqual(compatibilityNote.futureMetadata, { schema: 7, flags: ['keep-me'] }, 'web edits retain unrecognized fields');
    assert.equal(compatibilityNote.clientExtension, 'preserved');
    const clone = await request(`/notes/${original.id}/clone`, owner.token, {}, 'POST');
    const clonedNote = await request(`/notes/${clone.id}`, owner.token);
    assert.deepEqual(clonedNote.futureMetadata, { schema: 7, flags: ['keep-me'] }, 'clones retain unrecognized fields');
    assert.equal(clonedNote.clientExtension, 'preserved');
    const mergeSourceA = await request('/notes', owner.token, { noteTitle: 'Merge A', futureA: 'a', sharedFuture: 'A' });
    const mergeSourceB = await request('/notes', owner.token, { noteTitle: 'Merge B', futureB: 'b', sharedFuture: 'B' });
    const merged = await request('/notes/merge', owner.token, { orderedIds: [mergeSourceA.id, mergeSourceB.id] });
    const mergedNote = await request(`/notes/${merged.id}`, owner.token);
    assert.equal(mergedNote.futureA, 'a');
    assert.equal(mergedNote.futureB, 'b');
    assert.equal(mergedNote.sharedFuture, 'A', 'merge keeps the first source value for conflicting unknown fields');
    let imageNote = await request(`/notes/${original.id}`, owner.token);
    const linkImage = { type: 'note.upsert', syncId: imageNote.syncId, baseRevision: imageNote.revision, operationId: 'link-retried-image',
      payload: { ...imageNote, images: [{ id: 'test-image', dataUrl: firstImage.url, name: 'pixel.png', placement: 'top' }] } };
    assert.equal((await mutate(owner.token, [linkImage])).results[0].ok, true);
    imageNote = await request(`/notes/${original.id}`, owner.token);
    assert.equal((await mutate(owner.token, [{ type: 'note.upsert', syncId: imageNote.syncId, baseRevision: imageNote.revision,
      operationId: 'edit-linked-image', payload: { ...imageNote, noteTitle: 'Edited after image link' } }])).results[0].ok, true);
    const retryAfterEdit = await uploadImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64'));
    await verifyRegression('R6 image replay survives note edits', () => assert.equal(retryAfterEdit.url, firstImage.url,
      'editing a note must not erase its image-upload replay identity'));
    const uploadAttachment = async (content, expectedStatus = null) => {
      const form = new FormData();
      form.append('file', new Blob([content], { type: 'text/plain' }), 'replay.txt');
      form.append('syncId', 'attachment-retry-stable');
      const response = await fetch(`${base}/notes/${original.id}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form });
      if (expectedStatus !== null) assert.equal(response.status, expectedStatus, `attachment upload: ${await response.clone().text()}`);
      else assert.ok(response.ok, `attachment upload: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    const firstAttachment = await uploadAttachment('first body');
    const retryAttachment = await uploadAttachment('first body');
    assert.equal(retryAttachment.id, firstAttachment.id, 'attachment retry must reuse its stable sync ID');
    const mismatchedAttachment = await uploadAttachment('different body', 409);
    assert.ok(mismatchedAttachment.error, 'an attachment ID cannot be reused for different bytes');
    const otherNote = await request('/notes', owner.token, { noteTitle: 'Different destination', noteBody: '', checkBoxes: [], images: [], labels: [] });
    const reparentForm = new FormData();
    reparentForm.append('file', new Blob(['first body'], { type: 'text/plain' }), 'replay.txt');
    reparentForm.append('syncId', 'attachment-retry-stable');
    const reparentResponse = await fetch(`${base}/notes/${otherNote.id}/attachments`, {
      method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: reparentForm
    });
    assert.equal(reparentResponse.status, 409, 'an accepted attachment identity cannot be reparented to another note');
    await reparentResponse.arrayBuffer();
    await request(`/notes/${original.id}/collaborators`, owner.token, { userIds: [editor.user.id] }, 'PUT');
    const collapseOwner = await mutate(owner.token, [{ type: 'note.view-state', syncId: original.syncId,
      operationId: 'owner-collapse-state', payload: { completedChecklistCollapsed: true } }]);
    assert.equal(collapseOwner.results[0].ok, true, 'personal view state is an accepted native mutation');
    assert.equal((await request(`/notes/${original.id}`, owner.token)).completedChecklistCollapsed, true);
    assert.equal((await request(`/notes/${original.id}`, editor.token)).completedChecklistCollapsed, false,
      'one collaborator cannot overwrite another user\'s checklist-collapse preference');
    const editorBootstrap = await request('/sync/bootstrap', editor.token);
    await request(`/notes/${original.id}/view-state`, editor.token, { completedChecklistCollapsed: true }, 'PATCH');
    const editorViewStateChanges = await request(`/sync/changes?cursor=${editorBootstrap.cursor}`, editor.token);
    assert.equal(editorViewStateChanges.changes.find(change => change.resourceSyncId === original.syncId)?.payload?.completedChecklistCollapsed, true,
      'web view-state changes reach native clients incrementally for that user');
    assert.equal((await request(`/notes/${original.id}`, owner.token)).completedChecklistCollapsed, true);
    assert.equal((await request(`/notes/${original.id}`, editor.token)).completedChecklistCollapsed, true);
    const collapseEditor = await mutate(editor.token, [{ type: 'note.view-state', syncId: original.syncId,
      operationId: 'editor-collapse-state', payload: { completedChecklistCollapsed: false } }]);
    assert.equal(collapseEditor.results[0].ok, true);
    assert.equal((await request(`/notes/${original.id}`, owner.token)).completedChecklistCollapsed, true);
    assert.equal((await request(`/notes/${original.id}`, editor.token)).completedChecklistCollapsed, false);
    const note = await request(`/notes/${original.id}`, owner.token);
    const save = (title, operationId) => ({ type: 'note.upsert', syncId: note.syncId, baseRevision: note.revision, operationId,
      payload: { ...note, noteTitle: title } });
    const [first, second] = await Promise.all([
      mutate(owner.token, [save('Owner draft', 'owner-save')]), mutate(editor.token, [save('Editor draft', 'editor-save')])
    ]);
    const outcomes = [first.results[0], second.results[0]];
    assert.equal(outcomes.filter(result => result.ok).length, 1, 'exactly one concurrent save succeeds');
    assert.equal(outcomes.find(result => !result.ok).status, 409);
    assert.ok(outcomes.find(result => !result.ok).latest.noteTitle.endsWith('draft'));
    const winnerToken = first.results[0].ok ? owner.token : editor.token;
    const winner = first.results[0].ok ? save('Owner draft', 'owner-save') : save('Editor draft', 'editor-save');
    const revision = (await request(`/notes/${note.id}`, owner.token)).revision;
    await mutate(winnerToken, [winner]);
    assert.equal((await request(`/notes/${note.id}`, owner.token)).revision, revision, 'retry must not write again');
    const mismatch = await mutate(winnerToken, [{ ...winner, payload: { ...winner.payload, noteTitle: 'Changed retry' } }]);
    assert.equal(mismatch.results[0].status, 409);
    const beforeLostResponse = await request(`/notes/${note.id}`, owner.token);
    const lostResponseMutation = { type: 'note.upsert', syncId: note.syncId, baseRevision: beforeLostResponse.revision,
      operationId: 'accepted-response-dropped', payload: { ...beforeLostResponse, noteTitle: 'Accepted without response' } };
    await assert.rejects(fetch(`${base}/sync/mutations`, {
      method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json', 'X-Kept-Test-Drop-Response': '1' },
      body: JSON.stringify({ mutations: [lostResponseMutation] })
    }), 'the harness should be able to simulate a lost successful response');
    const afterLostResponse = await request(`/notes/${note.id}`, owner.token);
    assert.equal(afterLostResponse.noteTitle, 'Accepted without response');
    const lostResponseRevision = afterLostResponse.revision;
    await stopServer(child);
    child = startServer();
    await waitForServer(child);
    const imageAfterRestart = await uploadImage(imageBytes);
    assert.equal(imageAfterRestart.url, firstImage.url, 'image upload receipt survives server restart');
    const attachmentAfterRestart = await uploadAttachment('first body');
    assert.equal(attachmentAfterRestart.id, firstAttachment.id, 'attachment receipt survives server restart');
    await mutate(winnerToken, [winner]);
    assert.equal((await request(`/notes/${note.id}`, owner.token)).revision, lostResponseRevision, 'accepted operation receipt survives a server restart');
    await mutate(owner.token, [lostResponseMutation]);
    assert.equal((await request(`/notes/${note.id}`, owner.token)).revision, lostResponseRevision, 'lost-response replay survives a server restart');

    const beforeCrash = await request(`/notes/${note.id}`, owner.token);
    const crashMutation = { type: 'note.upsert', syncId: note.syncId, baseRevision: beforeCrash.revision,
      operationId: 'crash-before-receipt', payload: { ...beforeCrash, noteTitle: 'Crash-window draft' } };
    await request('/test/failpoint', owner.token, { name: 'after-mutation-before-receipt', mode: 'crash' });
    await assert.rejects(fetch(`${base}/sync/mutations`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations: [crashMutation] }) }), 'armed crash failpoint should terminate the request process');
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    child = startServer();
    await waitForServer(child);
    const afterCrash = await request(`/notes/${note.id}`, owner.token);
    const replayAfterCrash = await mutate(owner.token, [crashMutation]);
    const afterCrashReplay = await request(`/notes/${note.id}`, owner.token);
    verifyRegression('R7 mutation and receipt share one crash-atomic transaction', () => {
      assert.equal(afterCrash.revision, beforeCrash.revision, 'crash before commit must roll back the document write');
      assert.equal(replayAfterCrash.results[0].ok, true, 'replaying after rollback must be accepted');
      assert.equal(afterCrashReplay.revision, beforeCrash.revision + 1, 'the replay applies the mutation exactly once');
      assert.equal(afterCrashReplay.noteTitle, 'Crash-window draft');
    });
    const beforePostCommitCrash = await request(`/notes/${note.id}`, owner.token);
    const committedBeforeLostResponse = { type: 'note.upsert', syncId: note.syncId, baseRevision: beforePostCommitCrash.revision,
      operationId: 'crash-after-receipt', payload: { ...beforePostCommitCrash, noteTitle: 'Committed before process exit' } };
    await request('/test/failpoint', owner.token, { name: 'after-receipt-before-response', mode: 'crash' });
    await assert.rejects(fetch(`${base}/sync/mutations`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations: [committedBeforeLostResponse] }) }));
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    child = startServer();
    await waitForServer(child);
    const committedState = await request(`/notes/${note.id}`, owner.token);
    const committedReplay = await mutate(owner.token, [committedBeforeLostResponse]);
    const committedStateAfterReplay = await request(`/notes/${note.id}`, owner.token);
    verifyRegression('R7 accepted write and receipt survive a crash before response', () => {
      assert.equal(committedState.noteTitle, 'Committed before process exit');
      assert.equal(committedReplay.results[0].ok, true);
      assert.equal(committedStateAfterReplay.revision, committedState.revision);
    });
    const beforeInterleave = await request(`/notes/${note.id}`, owner.token);
    const nativeDuringLegacy = { type: 'note.upsert', syncId: note.syncId, baseRevision: beforeInterleave.revision,
      operationId: 'native-transaction-interleave', payload: { ...beforeInterleave, noteTitle: 'Native transaction value' } };
    await request('/test/failpoint', owner.token, { name: 'after-mutation-before-receipt', mode: 'pause', pauseMs: 500 });
    const nativeRequest = fetch(`${base}/sync/mutations`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations: [nativeDuringLegacy] }) });
    await new Promise(resolve => setTimeout(resolve, 80));
    let legacyCompleted = false;
    const legacyRequest = request(`/notes/${note.id}`, owner.token, { noteBody: 'Legacy write after native commit' }, 'PATCH')
      .then(result => { legacyCompleted = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 80));
    const legacyWasIsolatedFromOpenTransaction = !legacyCompleted;
    const nativeResponse = await nativeRequest;
    assert.equal(nativeResponse.status, 200);
    await legacyRequest;
    verifyRegression('WP2 legacy writes cannot join an open native transaction', () => assert.equal(legacyWasIsolatedFromOpenTransaction, true));
    await request(`/notes/${note.id}`, owner.token, { noteBody: '<b>Updated on web</b>' }, 'PATCH');
    const stale = await mutate(owner.token, [{ ...save('Stale', 'web-stale-save'), baseRevision: revision }]);
    assert.equal(stale.results[0].status, 409, 'legacy web writes increment revisions');

    const due = new Date(Date.now() + 3600000).toISOString();
    const r1 = await request('/reminders', owner.token, { noteId: note.id, dueAtUtc: due, timezone: 'UTC' });
    const r2 = await request('/reminders', editor.token, { noteId: note.id, dueAtUtc: due, timezone: 'UTC' });
    assert.notEqual(r1.id, r2.id);
    const reminderMutation = (reminder, dueAtUtc, operationId) => ({ type: 'reminder.upsert', syncId: reminder.syncId,
      baseScheduleVersion: reminder.scheduleVersion, operationId, payload: { ...reminder, dueAtUtc, scheduleVersion: reminder.scheduleVersion + 1 } });
    const competingScheduleUpdates = await Promise.all([
      mutate(owner.token, [reminderMutation(r1, new Date(Date.now() + 3 * 3600000).toISOString(), 'schedule-a')]),
      mutate(owner.token, [reminderMutation(r1, new Date(Date.now() + 4 * 3600000).toISOString(), 'schedule-b')])
    ]);
    const scheduleResults = competingScheduleUpdates.map(response => response.results[0]);
    await verifyRegression('R8 same-base reminder writes have one winner', () => assert.equal(scheduleResults.filter(result => result.ok).length, 1,
      'same-base reminder schedule updates must have one winner'));
    const scheduleWinner = scheduleResults.find(result => result.ok);
    const storedSchedule = (await request('/reminders', owner.token)).find(row => row.id === r1.id);
    if (scheduleWinner) await verifyRegression('R4 reminder result reports committed version', () => assert.equal(scheduleWinner.payload.scheduleVersion, storedSchedule.scheduleVersion,
      'mutation results must carry the committed schedule version'));
    else regressionFailures.push('R4 reminder result version check skipped because no competing write succeeded.');
    const changedDue = new Date(Date.now() + 7200000).toISOString();
    const changedSchedule = await request(`/reminders/${r1.id}`, owner.token, { dueAtUtc: changedDue }, 'PATCH');
    assert.equal(changedSchedule.scheduleVersion, storedSchedule.scheduleVersion + 1, 'definition edits increment schedule version exactly once');
    const noOpSchedule = await request(`/reminders/${r1.id}`, owner.token, { dueAtUtc: changedDue }, 'PATCH');
    assert.equal(noOpSchedule.scheduleVersion, changedSchedule.scheduleVersion, 'no-op schedule updates do not increment the definition version');
    assert.equal((await request('/reminders', owner.token)).find(row => row.id === r1.id).dueAtUtc, changedDue);
    assert.equal((await request('/reminders', editor.token)).find(row => row.id === r2.id).dueAtUtc, due, 'editing one personal reminder must not change the other');
    const foreignPatch = await fetch(`${base}/reminders/${r1.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${editor.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'dismissed' }) });
    assert.equal(foreignPatch.status, 404, 'another user cannot patch a personal reminder');
    await request(`/reminders/${r1.id}`, owner.token, { status: 'dismissed' }, 'PATCH');
    assert.equal((await request('/reminders', editor.token)).find(row => row.id === r2.id).status, 'pending');
    const theft = await mutate(editor.token, [{ type: 'reminder.upsert', syncId: r1.syncId, payload: { ...r1, title: 'Stolen' } }]);
    assert.equal(theft.results[0].status, 403);
    const deletion = await mutate(editor.token, [{ type: 'reminder.delete', syncId: r1.syncId, payload: {} }]);
    assert.equal(deletion.results[0].status, 403);
    await request(`/reminders/${r1.id}`, owner.token, undefined, 'DELETE');
    assert.equal((await request('/reminders', editor.token)).length, 1);
    await request(`/notes/${original.id}/attachments/${firstAttachment.id}`, owner.token, undefined, 'DELETE');
    const deletedAttachmentReplay = await uploadAttachment('first body', 410);
    assert.ok(deletedAttachmentReplay.error);

    const past = new Date(Date.now() - 1000).toISOString();
    const timed = await request('/reminders', owner.token, { noteId: note.id, dueAtUtc: past, timezone: 'UTC', repeatRule: '{"type":"daily"}' });
    const action = { type: 'reminder.action', operationId: 'snooze-action', payload: { reminderSyncId: timed.syncId,
      occurrenceId: occurrenceId(timed), scheduleVersion: timed.scheduleVersion, state: 'snoozed', snoozeUntil: due } };
    assert.equal((await mutate(owner.token, [action])).results[0].ok, true);
    await mutate(owner.token, [action]);
    const occurrences = await request('/native/reminders/occurrences', owner.token);
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].state, 'snoozed');
    assert.equal(occurrences[0].snoozeUntil, due);
    const expiredSnooze = new Date(Date.now() - 60_000).toISOString();
    const replayedOfflineSnooze = await mutate(owner.token, [{ ...action, operationId: 'offline-snooze-after-deadline',
      payload: { ...action.payload, snoozeUntil: expiredSnooze } }]);
    assert.equal(replayedOfflineSnooze.results[0].ok, true, 'a valid snooze is acknowledged even if reconnect happens after its deadline');
    assert.equal((await request('/native/reminders/occurrences', owner.token))[0].snoozeUntil, expiredSnooze);
    const crossAction = await mutate(editor.token, [{ ...action, operationId: 'foreign-snooze' }]);
    assert.equal(crossAction.results[0].ok, false);
    const repeat = (await request('/reminders', owner.token)).find(row => row.id === timed.id);
    assert.equal(JSON.parse(repeat.repeatRule).type, 'daily', 'occurrence actions do not destroy recurrence');
    await request(`/reminders/${timed.id}`, owner.token, { status: 'dismissed' }, 'PATCH');
    assert.equal((await request('/native/reminders/occurrences', owner.token)).length, 0, 'dismissed reminders must not reschedule stale occurrences');

    const offlineAnchor = new Date(Date.now() - 4 * 24 * 3600000).toISOString();
    const offlineReminder = await request('/reminders', owner.token, { syncId: 'offline-later-occurrence', dueAtUtc: offlineAnchor,
      timezone: 'UTC', repeatRule: '{"type":"daily"}' });
    await request('/test/reminders/tick', owner.token, { now: new Date().toISOString() });
    const advancedOfflineReminder = (await request('/reminders', owner.token)).find(row => row.syncId === offlineReminder.syncId);
    assert.ok(Date.parse(advancedOfflineReminder.dueAtUtc) > Date.now(), 'server cursor advances beyond missed daily occurrences');
    const laterOfflineDue = new Date(Date.parse(offlineAnchor) + 2 * 24 * 3600000).toISOString();
    const laterOfflineAction = { type: 'reminder.action', operationId: 'later-offline-occurrence-action', payload: {
      reminderSyncId: offlineReminder.syncId, occurrenceId: occurrenceId({ ...offlineReminder, dueAtUtc: laterOfflineDue }),
      scheduleVersion: offlineReminder.scheduleVersion, state: 'snoozed', snoozeUntil: due
    } };
    assert.equal((await mutate(owner.token, [laterOfflineAction])).results[0].ok, true,
      'a valid later recurrence action remains accepted after the cursor advances');
    const laterOccurrence = (await request('/native/reminders/occurrences', owner.token))
      .find(row => row.occurrenceId === laterOfflineAction.payload.occurrenceId);
    assert.equal(laterOccurrence.dueAtUtc, laterOfflineDue);
    assert.equal(laterOccurrence.state, 'snoozed');

    const deterministicReminder = await request('/reminders', owner.token, {
      syncId: 'deterministic-daily', dueAtUtc: '2030-01-01T09:00:00.000Z', timezone: 'UTC', repeatRule: '{"type":"daily"}'
    });
    const tick = await request('/test/reminders/tick', owner.token, { now: '2030-01-01T10:00:00.000Z' });
    assert.ok(tick.dueCount >= 1, 'deterministic tick should see the synthetic reminder as due');
    const advancedReminder = (await request('/reminders', owner.token)).find(row => row.syncId === deterministicReminder.syncId);
    assert.equal(advancedReminder.dueAtUtc, '2030-01-02T09:00:00.000Z');
    const allOccurrences = await request('/native/reminders/occurrences', owner.token);
    const dueOccurrence = allOccurrences.find(row => row.syncId === deterministicReminder.syncId);
    if (!dueOccurrence) regressionFailures.push(`deterministic scheduler tick did not persist an occurrence: ${JSON.stringify(allOccurrences)}`);
    else await verifyRegression('deterministic scheduler tick records the due occurrence', () => assert.equal(dueOccurrence.occurrenceId, occurrenceId(deterministicReminder)));
    await verifyRegression('R3 occurrence roll-forward keeps schedule-definition version', () => assert.equal(advancedReminder.scheduleVersion,
      deterministicReminder.scheduleVersion, 'advancing the recurrence cursor must not change the schedule-definition version'));
    const cursorOnlyMutation = { type: 'reminder.upsert', syncId: deterministicReminder.syncId,
      baseScheduleVersion: advancedReminder.scheduleVersion, operationId: 'edit-reminder-details-after-roll-forward',
      payload: { ...deterministicReminder, title: 'Updated reminder title' } };
    assert.equal((await mutate(owner.token, [cursorOnlyMutation])).results[0].ok, true);
    const afterCursorOnlyEdit = (await request('/reminders', owner.token)).find(row => row.syncId === deterministicReminder.syncId);
    assert.equal(afterCursorOnlyEdit.dueAtUtc, advancedReminder.dueAtUtc, 'detail edits with an unchanged definition keep the advanced cursor');
    assert.equal(afterCursorOnlyEdit.scheduleVersion, advancedReminder.scheduleVersion);

    const privateNote = await request('/notes', owner.token, { syncId: 'revoked-content-check', noteTitle: 'Shared title', noteBody: 'Shared body', checkBoxes: [], images: [], labels: [] });
    const privateImageForm = new FormData();
    privateImageForm.append('image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'private.png');
    privateImageForm.append('operationId', 'revoked-note-image');
    const privateImageResponse = await fetch(base + '/uploads/images', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: privateImageForm });
    assert.equal(privateImageResponse.status, 201);
    const privateImage = await privateImageResponse.json();
    const privateImageNote = await request(`/notes/${privateNote.id}`, owner.token);
    assert.equal((await mutate(owner.token, [{ type: 'note.upsert', syncId: privateNote.syncId, baseRevision: privateNote.revision,
      operationId: 'attach-revoked-note-image', payload: { ...privateImageNote,
        images: [{ id: 'private', dataUrl: privateImage.url, name: 'private.png', placement: 'top' }] } }])).results[0].ok, true);
    await request(`/notes/${privateNote.id}/collaborators`, owner.token, { userIds: [editor.user.id] }, 'PUT');
    const privateReminder = await request('/reminders', editor.token, { noteId: privateNote.id, dueAtUtc: due, timezone: 'UTC' });
    const cursorBeforeReminderMutation = (await request('/sync/bootstrap', editor.token)).cursor;
    const replayedReminderMutation = { type: 'reminder.upsert', syncId: privateReminder.syncId, operationId: 'revoked-reminder-replay',
      payload: { ...privateReminder, noteSyncId: privateNote.syncId, title: 'Shared title', body: 'Shared body' } };
    assert.equal((await mutate(editor.token, [replayedReminderMutation])).results[0].ok, true);
    const calendarToken = (await request('/reminders/ics-token', editor.token)).token;
    const editorImage = await fetch(origin + privateImage.url, { headers: { Authorization: `Bearer ${editor.token}` } });
    assert.equal(editorImage.status, 200, 'collaborator can load an image before access is revoked');
    await request('/test/reminders/tick', editor.token, { now: new Date(Date.parse(due) + 1000).toISOString() });
    const occurrenceBeforeRevoke = await request('/native/reminders/occurrences', editor.token);
    assert.ok(occurrenceBeforeRevoke.some(row => row.syncId === privateReminder.syncId));
    await request(`/notes/${privateNote.id}/collaborators`, owner.token, { userIds: [] }, 'PUT');
    await request(`/notes/${privateNote.id}`, owner.token, { noteTitle: 'Private title after revoke', noteBody: 'Private body after revoke' }, 'PATCH');
    const revokedSnapshot = await request('/sync/bootstrap', editor.token);
    assert.equal(revokedSnapshot.notes.some(row => row.id === privateNote.id), false);
    const leakedReminder = revokedSnapshot.reminders.find(row => row.syncId === privateReminder.syncId);
    await verifyRegression('R1 revocation hides current content from personal reminders', () => assert.ok(!leakedReminder ||
      (!String(leakedReminder.title || '').includes('Private') && !String(leakedReminder.body || '').includes('Private')),
    'revoked collaborator must not receive current private note content through a personal reminder'));
    const revokedReminders = await request('/reminders', editor.token);
    await verifyRegression('R1 revocation filters direct reminder reads', () => assert.equal(revokedReminders.some(row => row.syncId === privateReminder.syncId), false));
    const revokedChanges = await request(`/sync/changes?cursor=${cursorBeforeReminderMutation}`, editor.token);
    const historicalReminderChange = revokedChanges.changes.find(row => row.resourceSyncId === replayedReminderMutation.syncId);
    await verifyRegression('R1 revocation redacts queued reminder changes without stalling the cursor', () => {
      assert.equal(historicalReminderChange?.operation, 'delete');
      assert.equal(historicalReminderChange?.payload, null);
      assert.ok(revokedChanges.cursor > cursorBeforeReminderMutation);
    });
    const replayedAfterRevocation = (await mutate(editor.token, [replayedReminderMutation])).results[0];
    await verifyRegression('WP1 replay acknowledges accepted work without exposing revoked content', () => {
      assert.equal(replayedAfterRevocation.ok, true);
      assert.equal(replayedAfterRevocation.payload, undefined);
    });
    await verifyRegression('R1 revocation blocks direct note reads', async () => {
      const response = await fetch(`${base}/notes/${privateNote.id}`, { headers: { Authorization: `Bearer ${editor.token}` } });
      assert.equal(response.status, 404);
    });
    await verifyRegression('R1 revocation blocks cached private image reads', async () => {
      const response = await fetch(origin + privateImage.url, { headers: { Authorization: `Bearer ${editor.token}` } });
      assert.equal(response.status, 404);
    });
    await verifyRegression('R1 revocation removes private occurrences', async () => {
      const visible = await request('/native/reminders/occurrences', editor.token);
      assert.equal(visible.some(row => row.syncId === privateReminder.syncId), false);
    });
    await verifyRegression('R1 revocation removes private reminder from ICS', async () => {
      const response = await fetch(`${base}/reminders/ics/${calendarToken}`);
      const ics = await response.text();
      assert.equal(response.status, 200);
      assert.equal(ics.includes('Private body after revoke'), false);
    });
    assert.deepEqual(regressionFailures, [], `Known review regressions remain:\n${regressionFailures.join('\n')}`);
    console.log('Native server migration and protocol tests passed.');
  } finally {
    await stopServer(child);
    rmSync(directory, { recursive: true, force: true });
  }
}

migrationTest().then(integrationTest).catch(error => { console.error(error); process.exitCode = 1; });
