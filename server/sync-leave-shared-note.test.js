// node --test server/sync-leave-shared-note.test.js
// Issue #176: a collaborator's queued note.delete must mean "leave this note"
// on the sync path, exactly like REST DELETE /api/notes/:id, instead of a 403
// that blocks the device's whole sync queue.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('sync note.delete from a collaborator leaves the note', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const password = 'leave-shared-note-password';
  let sequence = 0;
  async function api(path, body, token, method = body === undefined ? 'GET' : 'POST', status = 200) {
    const response = await fetch(`${fixture.origin}/api${path}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, status, await response.clone().text());
    return status === 204 ? null : response.json();
  }
  async function mutate(type, syncId, payload, token, physicalMs = Date.now() + ++sequence) {
    const operationId = `leave-test-${++sequence}`;
    const response = await api('/sync/mutations', { protocolVersion: 2, mutations: [{ type, syncId, payload, operationId,
      lww: { physicalMs, logical: sequence, deviceId: 'leave-test', operationId } }] }, token);
    return response.results[0];
  }
  const note = (title, token) => api('/notes', { noteTitle: title, noteBody: `<p>${title}</p>`, labels: [], images: [], checkBoxes: [] }, token, 'POST', 201);

  await api('/setup/admin', { username: 'owner', password }, undefined, 'POST', 201);
  const owner = (await api('/auth/login', { username: 'owner', password })).token;
  const collabUser = await api('/users', { username: 'collab', password, displayName: 'Collab' }, owner, 'POST', 201);
  const collab = (await api('/auth/login', { username: 'collab', password })).token;

  await t.test('the collaborator leaves; the owner keeps the note', async () => {
    const shared = await note('Shared', owner);
    await api(`/notes/${shared.id}/collaborators`, { userIds: [collabUser.id] }, owner, 'PUT');
    await api(`/notes/${shared.id}`, undefined, collab);

    const result = await mutate('note.delete', shared.syncId, { id: shared.id, syncId: shared.syncId }, collab);
    assert.equal(result.ok, true, JSON.stringify(result));
    await api(`/notes/${shared.id}`, undefined, collab, 'GET', 404);
    assert.equal((await api(`/notes/${shared.id}`, undefined, owner)).noteTitle, 'Shared');
    assert.deepEqual(await api(`/notes/${shared.id}/collaborators`, undefined, owner), []);
    // Same rejoin grant the REST leave records, so Undo keeps working.
    const grants = await fixture.sql('SELECT userId FROM note_collaborator_rejoin_grants WHERE noteId = ?', [shared.id]);
    assert.deepEqual(grants.map(row => row.userId), [collabUser.id]);
  });

  await t.test('an owner edit made after the leave was queued does not cancel it', async () => {
    const shared = await note('Edited later', owner);
    await api(`/notes/${shared.id}/collaborators`, { userIds: [collabUser.id] }, owner, 'PUT');
    const queuedAt = Date.now() - 60000; // queued offline a minute ago
    await api(`/notes/${shared.id}`, { noteTitle: 'Edited later', noteBody: '<p>new</p>' }, owner, 'PATCH', 204);
    const result = await mutate('note.delete', shared.syncId, { id: shared.id, syncId: shared.syncId }, collab, queuedAt);
    assert.equal(result.ok, true, JSON.stringify(result));
    await api(`/notes/${shared.id}`, undefined, collab, 'GET', 404);
  });

  await t.test('replaying the delete after leaving still succeeds', async () => {
    const shared = await note('Replayed', owner);
    await api(`/notes/${shared.id}/collaborators`, { userIds: [collabUser.id] }, owner, 'PUT');
    assert.equal((await mutate('note.delete', shared.syncId, { id: shared.id, syncId: shared.syncId }, collab)).ok, true);
    const again = await mutate('note.delete', shared.syncId, { id: shared.id, syncId: shared.syncId }, collab);
    assert.equal(again.ok, true, JSON.stringify(again));
  });

  await t.test('a note shared through a binder is refused permanently, not retried', async () => {
    const binder = await mutate('binder.upsert', 'binder-team', { name: 'Team' }, owner);
    assert.equal(binder.ok, true, JSON.stringify(binder));
    await api(`/binders/${binder.id}/members`, { userIds: [collabUser.id] }, owner, 'PUT');
    const inBinder = await api('/notes', { noteTitle: 'Team note', noteBody: '<p>t</p>', binder: 'Team', labels: [], images: [], checkBoxes: [] }, owner, 'POST', 201);
    await api(`/notes/${inBinder.id}`, undefined, collab);
    const result = await mutate('note.delete', inBinder.syncId, { id: inBinder.id, syncId: inBinder.syncId }, collab);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.match(result.error, /shared binder/);
    await api(`/notes/${inBinder.id}`, undefined, collab);
  });

  await t.test('REST DELETE from a collaborator still leaves the note', async () => {
    const shared = await note('REST leave', owner);
    await api(`/notes/${shared.id}/collaborators`, { userIds: [collabUser.id] }, owner, 'PUT');
    await api(`/notes/${shared.id}`, undefined, collab, 'DELETE', 204);
    await api(`/notes/${shared.id}`, undefined, collab, 'GET', 404);
    assert.equal((await api(`/notes/${shared.id}`, undefined, owner)).noteTitle, 'REST leave');
  });
});
