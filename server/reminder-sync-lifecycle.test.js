const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');
const { createStore } = require('../test-support/workspace-store.cjs');

for (const lifecycle of ['trashed', 'archived']) {
  test(`queued reminder edits sync while the linked note is ${lifecycle}`, async () => {
    const fixture = await startFixture();
    let token;
    let sequence = 0;
    const credentials = {
      username: 'reminder-repro',
      displayName: 'Reminder Reproduction',
      password: 'isolated-test-password-123'
    };
    async function request(route, body, expectedStatus = 200) {
      const response = await fetch(`${fixture.origin}/api${route}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      assert.equal(response.status, expectedStatus, await response.clone().text());
      return response.json();
    }
    function mutation(type, syncId, payload) {
      const operationId = `repro-${++sequence}`;
      return {
        type, syncId, payload, operationId,
        lww: { physicalMs: Date.now(), logical: sequence, deviceId: 'repro', operationId }
      };
    }
    const send = mutations => request('/sync/mutations', { protocolVersion: 2, mutations });
    try {
      await request('/setup/admin', credentials, 201);
      token = (await request('/auth/login', credentials)).token;
      const created = await send([
        mutation('note.upsert', 'repro-note', {
          noteTitle: 'Synthetic reminder note', noteBody: 'Original content',
          archived: false, trashed: false
        }),
        mutation('reminder.upsert', 'repro-reminder', {
          noteSyncId: 'repro-note', title: 'Original title',
          dueAtUtc: new Date(Date.now() + 86400000).toISOString(),
          timezone: 'UTC', status: 'pending'
        })
      ]);
      assert.ok(created.results.every(result => result.ok));

      // Exercise the actual client IndexedDB reconciliation, not a mock queue.
      const store = createStore();
      const workspace = await store.ensureServerWorkspace('repro|1');
      await store.reconcile(workspace, { snapshot: {
        note: created.snapshot.notes, reminder: created.snapshot.reminders
      }, cursor: created.snapshot.cursor });
      const reminder = (await store.listReminders(workspace.partition))
        .find(item => item.syncId === 'repro-reminder');
      assert.ok(reminder);
      await store.commitMutation(workspace, 'note.upsert', 'repro-note', { [lifecycle]: true });
      await store.commitMutation(workspace, 'reminder.upsert', 'repro-reminder', {
        ...reminder, title: 'Refreshed note content'
      });
      const entries = await store.listOutbox(workspace.partition);
      const response = await send(entries);
      const noteResult = response.results.find(result => result.operationId === entries[0].operationId);
      const reminderResult = response.results.find(result => result.operationId === entries[1].operationId);
      assert.equal(noteResult.ok, true);
      assert.equal(reminderResult.ok, true, JSON.stringify(reminderResult));
      const stored = (await fixture.sql('SELECT * FROM reminders WHERE syncId = ?', ['repro-reminder']))[0];
      assert.equal(stored.title, 'Refreshed note content', 'queued edits are saved, not silently discarded');
      assert.equal(stored.dueAtUtc, reminder.dueAtUtc, 'trashing does not erase the schedule');
      assert.equal(stored.status, 'pending');
      assert.equal(response.snapshot.reminders.some(item => item.syncId === reminder.syncId), false);
      assert.equal((await request('/reminders')).some(item => item.syncId === reminder.syncId), false);
      const tick = await request('/test/reminders/tick', {
        now: new Date(Date.parse(reminder.dueAtUtc) + 1000).toISOString()
      });
      assert.equal(tick.dueCount, 0, 'inactive notes must not fire notifications');
      await store.reconcile(workspace, {
        sent: entries, results: response.results,
        snapshot: { note: response.snapshot.notes, reminder: response.snapshot.reminders },
        cursor: response.snapshot.cursor, serverTime: response.serverTime
      });
      const pending = await store.listOutbox(workspace.partition);
      assert.equal(pending.length, 0, 'the browser outbox clears without restoring the note');
      const retry = await send(entries);
      assert.deepEqual(retry.results, response.results, 'lost-response retries replay the same receipts');

      // Restoring a note retains its future reminder and the queued edits.
      assert.equal((await send([
        mutation('note.upsert', 'repro-note', { [lifecycle]: false })
      ])).results[0].ok, true);
      const restored = (await request('/reminders')).find(item => item.syncId === reminder.syncId);
      assert.ok(restored);
      assert.equal(restored.dueAtUtc, reminder.dueAtUtc);
      assert.equal(restored.status, 'pending');
      assert.equal((await fixture.sql('SELECT title FROM reminders WHERE syncId = ?', [reminder.syncId]))[0].title,
        'Refreshed note content');
    } finally {
      await fixture.close();
    }
  });
}

async function withFixture(run) {
  const fixture = await startFixture();
  let sequence = 0;
  async function request(route, { body, method = body ? 'POST' : 'GET', token, status = 200 } = {}) {
    const response = await fetch(`${fixture.origin}/api${route}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.status === 204 ? null : response.json();
  }
  function mutation(type, syncId, payload, physicalMs = Date.now()) {
    const operationId = `control-${++sequence}`;
    return { type, syncId, payload, operationId,
      lww: { physicalMs, logical: sequence, deviceId: 'control', operationId } };
  }
  const send = async (token, mutations, protocolVersion = 2) =>
    (await request('/sync/mutations', { token, body: { protocolVersion, mutations } })).results;
  try {
    const credentials = { username: 'owner', displayName: 'Owner', password: 'isolated-password-123' };
    await request('/setup/admin', { body: credentials, status: 201 });
    const login = await request('/auth/login', { body: credentials });
    await run({ fixture, request, mutation, send, token: login.token });
  } finally {
    await fixture.close();
  }
}

test('legacy sync drains existing inactive-note updates without bypassing last-write-wins', async () => {
  await withFixture(async ({ fixture, request, mutation, send, token }) => {
    const dueAtUtc = new Date(Date.now() + 86400000).toISOString();
    const created = await send(token, [
      mutation('note.upsert', 'legacy-note', { noteTitle: 'Legacy', trashed: false }),
      mutation('reminder.upsert', 'legacy-reminder', { noteSyncId: 'legacy-note', dueAtUtc, timezone: 'UTC' })
    ], 1);
    assert.ok(created.every(result => result.ok));
    const updated = await send(token, [
      mutation('note.upsert', 'legacy-note', { trashed: true }),
      mutation('reminder.upsert', 'legacy-reminder', { title: 'Newest title' })
    ], 1);
    assert.ok(updated.every(result => result.ok), JSON.stringify(updated));
    const [stale] = await send(token, [
      mutation('reminder.upsert', 'legacy-reminder', { title: 'Obsolete title' }, Date.now() - 60000)
    ], 1);
    assert.equal(stale.ok, true);
    assert.equal(stale.skipped, true);
    assert.equal((await fixture.sql('SELECT title FROM reminders WHERE syncId = ?', ['legacy-reminder']))[0].title,
      'Newest title');
    assert.equal((await request('/reminders', { token })).length, 0);
    const [deleted] = await send(token, [mutation('reminder.delete', 'legacy-reminder', {})], 1);
    assert.equal(deleted.ok, true, 'explicit reminder deletion still works while a note is inactive');
    assert.equal((await fixture.sql('SELECT * FROM reminders WHERE syncId = ?', ['legacy-reminder'])).length, 0);
  });
});

test('inactive-note sync still enforces reminder ownership, revoked sharing and target-note access', async () => {
  await withFixture(async ({ fixture, request, mutation, send, token }) => {
    const otherCredentials = { username: 'other', displayName: 'Other', password: 'other-password-123' };
    const other = await request('/users', { token, body: otherCredentials, status: 201 });
    const otherToken = (await request('/auth/login', { body: otherCredentials })).token;
    const dueAtUtc = new Date(Date.now() + 86400000).toISOString();
    const created = await send(token, [
      mutation('note.upsert', 'shared-note', { noteTitle: 'Shared' }),
      mutation('reminder.upsert', 'owner-reminder', { noteSyncId: 'shared-note', dueAtUtc, timezone: 'UTC' })
    ]);
    assert.ok(created.every(result => result.ok));
    const noteId = created[0].id;
    await request(`/notes/${noteId}/collaborators`, { token, method: 'PUT', body: { userIds: [other.id] } });
    assert.equal((await send(otherToken, [
      mutation('reminder.upsert', 'collaborator-reminder', { noteSyncId: 'shared-note', dueAtUtc, timezone: 'UTC' })
    ]))[0].ok, true);
    assert.equal((await send(token, [mutation('note.upsert', 'shared-note', { trashed: true })]))[0].ok, true);

    const [foreign] = await send(otherToken, [
      mutation('reminder.upsert', 'owner-reminder', { title: 'Not mine' })
    ]);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.status, 403);

    await request(`/notes/${noteId}/collaborators`, { token, method: 'PUT', body: { userIds: [] } });
    const [revoked] = await send(otherToken, [
      mutation('reminder.upsert', 'collaborator-reminder', { title: 'Access revoked' })
    ]);
    assert.equal(revoked.ok, false);
    assert.equal(revoked.status, 404);
    assert.equal(revoked.error, 'The linked note is no longer accessible.');

    const [privateNote] = await send(otherToken, [
      mutation('note.upsert', 'private-note', { noteTitle: 'Private' })
    ]);
    assert.equal(privateNote.ok, true);
    const [retarget] = await send(token, [
      mutation('reminder.upsert', 'owner-reminder', { noteId: privateNote.id })
    ]);
    assert.equal(retarget.ok, false);
    assert.equal(retarget.status, 404);
    const rows = await fixture.sql('SELECT noteId FROM reminders WHERE syncId = ?', ['owner-reminder']);
    assert.equal(rows[0].noteId, noteId, 'a rejected update cannot retarget a reminder');

    const [deleted] = await send(token, [mutation('note.delete', 'shared-note', {})]);
    assert.equal(deleted.ok, true);
    assert.equal((await fixture.sql('SELECT * FROM reminders WHERE noteId = ?', [noteId])).length, 0,
      'permanent note deletion removes its reminders');
  });
});
