const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createStore } = require('../test-support/workspace-store.cjs');

const exportsForUtility = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/utils/shared-note-organization.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports: exportsForUtility });
const { projectSharedOrganization } = exportsForUtility;
const note = {
  id: 42, syncId: 'shared-note', ownerUserId: 1, noteTitle: 'Shared note', noteBody: 'Full shared content',
  labels: [{ id: 2, name: 'Owner label', added: true }], binder: 'Owner binder',
  updatedAt: '2026-10-01T00:00:00.000Z', lwwPhysicalMs: 100,
  sharedOrganization: { ownerLabels: [{ id: 2, name: 'Owner label', added: true }], ownerBinder: 'Owner binder',
    personalLabels: [], personalBinder: '' }
};
const ownPreferences = { inheritSharedLabels: false, inheritSharedBinders: false };

test('offline personal changes replay over newer shared content without replacing it', async () => {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('recipient-workspace');
  await store.reconcile(workspace, { snapshot: { note: [note] }, cursor: 1 });
  const change = { binder: 'My binder', labels: [{ id: 9, name: 'My label', added: true }] };
  await store.commitMutation(workspace, 'note.organization', note.syncId, change);
  const [operation] = await store.listOutbox(workspace.partition);
  assert.equal(operation.type, 'note.organization');
  assert.deepEqual(Object.keys(operation.payload).sort(), ['binder', 'labels', 'syncId']);
  let cached = await store.getNote(workspace.partition, note.id);
  assert.equal(cached.noteBody, note.noteBody);
  assert.equal(cached.updatedAt, note.updatedAt);
  assert.equal(cached.lwwPhysicalMs, note.lwwPhysicalMs, 'organization has an independent clock');
  // An owner's edit arrives before the pending personal operation is acknowledged.
  const newer = { ...note, noteBody: 'New owner content', sharedOrganization: {
    ...note.sharedOrganization, ownerBinder: 'New owner binder' } };
  await store.reconcile(workspace, { changes: [{ sequence: 2, resourceType: 'note', resourceSyncId: note.syncId,
    operation: 'upsert', payload: newer }], cursor: 2 });
  cached = await store.getNote(workspace.partition, note.id);
  assert.equal(cached.noteBody, 'New owner content');
  assert.equal(projectSharedOrganization(cached, ownPreferences).binder, 'My binder');
  assert.equal(projectSharedOrganization(cached, {}).binder, 'New owner binder');
  assert.equal(projectSharedOrganization(cached, { inheritSharedLabels: false }).labels[0].name, 'My label');
  const canonical = { ...cached, binder: 'My binder', labels: change.labels };
  await store.reconcile(workspace, { sent: [operation], results: [{ operationId: operation.operationId, ok: true, canonical }] });
  assert.equal((await store.listOutbox(workspace.partition)).length, 0);
  cached = await store.getNote(workspace.partition, note.id);
  assert.equal(projectSharedOrganization(cached, ownPreferences).binder, 'My binder');
  assert.equal(projectSharedOrganization(cached, {}).labels[0].name, 'Owner label');
});

test('shared content autosaves omit organization, and offline catalog edits preserve personal choices', async () => {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('recipient-workspace');
  await store.reconcile(workspace, { snapshot: { note: [note],
    binder: [{ id: 5, syncId: 'my-binder', name: 'My binder' }],
    label: [{ id: 9, syncId: 'my-label', name: 'My label' }] }, cursor: 1 });
  await store.commitMutation(workspace, 'note.organization', note.syncId, {
    binder: 'My binder', labels: [{ id: 9, syncId: 'my-label', name: 'My label', added: true }] });
  let cached = await store.getNote(workspace.partition, note.id);
  await store.commitMutation(workspace, 'note.upsert', note.syncId, { ...cached, noteBody: 'My content edit' });
  let queued = await store.listOutbox(workspace.partition);
  const content = queued.find(entry => entry.type === 'note.upsert').payload;
  for (const field of ['sharedOrganization','labels','binder']) assert.equal(Object.hasOwn(content, field), false);
  await store.commitMutation(workspace, 'binder.upsert', 'my-binder', { id: 5, name: 'Renamed binder' });
  await store.commitMutation(workspace, 'label.upsert', 'my-label', { id: 9, name: 'Renamed label' });
  cached = await store.getNote(workspace.partition, note.id);
  assert.equal(projectSharedOrganization(cached, ownPreferences).binder, 'Renamed binder');
  assert.equal(projectSharedOrganization(cached, ownPreferences).labels[0].name, 'Renamed label');
  assert.equal(projectSharedOrganization(cached, {}).binder, 'Owner binder');
  queued = await store.listOutbox(workspace.partition);
  assert.equal(queued.find(entry => entry.type === 'note.organization').payload.binder, 'Renamed binder');
  await store.commitMutation(workspace, 'binder.delete', 'my-binder', {});
  await store.commitMutation(workspace, 'label.delete', 'my-label', {});
  cached = await store.getNote(workspace.partition, note.id);
  assert.equal(projectSharedOrganization(cached, ownPreferences).binder, '');
  assert.equal(projectSharedOrganization(cached, ownPreferences).labels.length, 0);
  assert.equal(projectSharedOrganization(cached, {}).labels[0].name, 'Owner label');
});

test('offline preference changes immediately update cached notes used by native snapshots', async () => {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('recipient-workspace');
  await store.reconcile(workspace, { snapshot: { note: [note] }, cursor: 1 });
  await store.commitMutation(workspace, 'preferences.patch', 'account-preferences', ownPreferences);
  let cached = await store.getNote(workspace.partition, note.id);
  assert.equal(cached.binder, '');
  assert.equal(cached.labels.length, 0);
  await store.commitMutation(workspace, 'note.organization', note.syncId, { binder: 'Mine' });
  await store.commitMutation(workspace, 'preferences.patch', 'account-preferences', { inheritSharedBinders: true });
  cached = await store.getNote(workspace.partition, note.id);
  assert.equal(cached.binder, 'Owner binder');
  assert.equal(cached.labels.length, 0, 'labels remain independently disabled');
  await store.commitMutation(workspace, 'preferences.patch', 'account-preferences', { inheritSharedBinders: false });
  assert.equal((await store.getNote(workspace.partition, note.id)).binder, 'Mine');
});

test('a new card updates organization while retaining the full cached note', async () => {
  const store = createStore();
  await store.putNote('recipient-workspace', note);
  const changed = { ...note, isCardPreview: true, noteBody: 'Preview', sharedOrganization: {
    ...note.sharedOrganization, personalBinder: 'New choice' } };
  await store.putNote('recipient-workspace', changed);
  const cached = await store.getNote('recipient-workspace', note.id);
  assert.equal(cached.noteBody, 'Full shared content');
  assert.equal(projectSharedOrganization(cached, ownPreferences).binder, 'New choice');
});

test('renaming a label does not add a label change to a queued binder-only move', async () => {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('recipient-workspace');
  await store.reconcile(workspace, { snapshot: { note: [note], label: [{ id: 9, syncId: 'my-label', name: 'Same name' }] }, cursor: 1 });
  await store.commitMutation(workspace, 'note.organization', note.syncId, { binder: 'Same name' });
  await store.commitMutation(workspace, 'label.upsert', 'my-label', { id: 9, name: 'Different label' });
  const move = (await store.listOutbox(workspace.partition)).find(entry => entry.type === 'note.organization');
  assert.equal(move.payload.binder, 'Same name');
  assert.equal(Object.hasOwn(move.payload, 'labels'), false);
});
