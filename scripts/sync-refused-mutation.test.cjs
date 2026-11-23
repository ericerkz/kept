// node --test scripts/sync-refused-mutation.test.cjs
// Issue #176: a change the server refuses for good (400/403/404) must leave
// the outbox, restore the server's version and be recorded as a conflict;
// otherwise it is retried forever and blocks every later change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../test-support/workspace-store.cjs');

async function setup(name) {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace(name);
  await store.reconcile(workspace, { snapshot: { note: [{ id: 5, syncId: 'shared', noteTitle: 'Shared note', labels: [], attachments: [] }] }, cursor: 1 });
  const deleted = await store.commitMutation(workspace, 'note.delete', 'shared', { id: 5, syncId: 'shared' });
  void deleted;
  const [entry] = await store.listOutbox(workspace.partition);
  return { store, workspace, entry };
}

test('a permanently refused delete leaves the queue and the note comes back', async t => {
  const { store, workspace, entry } = await setup('refused-delete');
  t.after(async () => { (await store.open()).close(); });
  assert.equal(entry.type, 'note.delete');
  assert.equal(await store.getNoteBySyncId(workspace.partition, 'shared'), undefined, 'optimistically removed');

  await store.reconcile(workspace, { sent: [entry],
    results: [{ operationId: entry.operationId, ok: false, status: 403, error: 'Only the owner can delete a note.' }] });

  assert.deepEqual(await store.listOutbox(workspace.partition), []);
  assert.equal((await store.getNoteBySyncId(workspace.partition, 'shared'))?.noteTitle, 'Shared note');
  const conflicts = await store.listConflicts(workspace.partition);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'Only the owner can delete a note.');
  assert.equal(conflicts[0].operation.operationId, entry.operationId);
});

for (const outcome of [
  { ok: false, error: 'A note label is waiting to synchronize.' },
  { ok: false, status: 409, error: 'The note changed before this update could be saved.' },
  { ok: false, status: 507, error: 'Storage quota exceeded.' }
]) {
  test(`a retryable refusal stays queued (${outcome.status || 'no status'})`, async t => {
    const { store, workspace, entry } = await setup(`retryable-${outcome.status || 'none'}`);
    t.after(async () => { (await store.open()).close(); });
    await store.reconcile(workspace, { sent: [entry], results: [{ operationId: entry.operationId, ...outcome }] });
    assert.equal((await store.listOutbox(workspace.partition)).length, 1);
    assert.deepEqual(await store.listConflicts(workspace.partition), []);
  });
}

for (const status of [400,403,404]) {
  test(`refused text edits remain recoverable and queued (${status})`, async t => {
    const { store, workspace } = await setup(`refused-content-${status}`);
    t.after(async () => { (await store.open()).close(); });
    // Remove the setup deletion, then queue a genuine content edit.
    const [deletion] = await store.listOutbox(workspace.partition);
    await store.reconcile(workspace, { sent: [deletion], results: [{ operationId: deletion.operationId, ok: false, status: 403 }] });
    await store.commitMutation(workspace, 'note.upsert', 'shared', { id: 5, syncId: 'shared', noteTitle: 'Unsaved work', noteBody: '<p>Keep this text</p>' });
    const [entry] = await store.listOutbox(workspace.partition);
    await store.reconcile(workspace, { sent: [entry], results: [{ operationId: entry.operationId, ok: false, status }] });
    assert.equal((await store.listOutbox(workspace.partition)).length, 1);
    assert.equal((await store.getNoteBySyncId(workspace.partition, 'shared')).noteBody, '<p>Keep this text</p>');
  });
}
