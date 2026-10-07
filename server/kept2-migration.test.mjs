import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLegacySnapshot, createMigrationPlan } = require('./kept2/migration.js');

test('kept2 migration snapshot is deterministic and non-destructive', () => {
  const input = {
    sourceVersion: '1.8.1',
    createdAt: '2026-01-01T00:00:00.000Z',
    notes: [{
      id: 7,
      syncId: 'note-stable',
      ownerUserId: 1,
      noteTitle: 'Legacy note',
      noteBody: '<b>rich body</b>',
      checkBoxes: JSON.stringify([{ id: 1, data: 'task', done: false, indentLevel: 2 }]),
      images: JSON.stringify([{ id: 'drawing', dataUrl: 'data:image/png;base64,abc', name: 'drawing.png' }]),
      labels: JSON.stringify([{ id: 3, name: 'work' }]),
      binder: 'projects',
      pinned: 1,
      archived: 0,
      trashed: 0,
      bgColor: '#fff8b8',
      extraFutureColumn: 'must survive',
      createdAt: '2025-12-30T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }],
    reminders: [{ id: 4, syncId: 'reminder-stable', noteId: 7, title: 'Remind', dueAt: '2026-02-01T00:00:00.000Z' }],
    attachments: [{ id: 5, syncId: 'attachment-stable', noteId: 7, originalName: 'file.pdf', storedFilename: 'abc.pdf', fileSize: 42, mimeType: 'application/pdf' }]
  };
  const snapshotA = createLegacySnapshot(input);
  const snapshotB = createLegacySnapshot(input);
  assert.equal(snapshotA.snapshotHash, snapshotB.snapshotHash);
  assert.equal(snapshotA.counts.notes, 1);
  assert.equal(input.notes[0].noteTitle, 'Legacy note', 'planner must not mutate legacy source rows');
});

test('kept2 migration plan creates syncId resources and preserves unknown fields', () => {
  const snapshot = createLegacySnapshot({
    createdAt: '2026-01-01T00:00:00.000Z',
    notes: [{
      id: 7,
      syncId: 'note-stable',
      ownerUserId: 1,
      noteTitle: 'Legacy note',
      noteBody: 'body',
      checkBoxes: '[]',
      images: '[]',
      labels: '[]',
      binder: 'projects',
      pinned: 1,
      sortOrder: 99,
      extraFutureColumn: '{"nested":true}',
      createdAt: '2025-12-30T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }],
    reminders: [{ id: 4, noteId: 7, title: 'Remind' }],
    attachments: [{ id: 5, noteId: 7, originalName: 'file.pdf', storedFilename: 'abc.pdf' }]
  });
  const plan = createMigrationPlan(snapshot, {
    vaultId: 'vault-test',
    deviceId: 'device-migration',
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(plan.vaultId, 'vault-test');
  assert.equal(plan.resources.some(resource => resource.resourceId === 'note-stable' && resource.resourceType === 'note.content'), true);
  assert.equal(plan.resources.some(resource => resource.resourceId === 'note-stable:owner' && resource.resourceType === 'note.ownerState'), true);
  assert.equal(plan.resources.some(resource => resource.resourceType === 'migrationBackup'), true);
  const content = plan.resources.find(resource => resource.resourceId === 'note-stable').plaintext;
  assert.deepEqual(content.unknownLegacyFields.extraFutureColumn, { nested: true });
  const reminder = plan.resources.find(resource => resource.resourceType === 'reminder').plaintext;
  assert.equal(reminder.noteSyncId, 'note-stable');
  const attachment = plan.resources.find(resource => resource.resourceType === 'attachment').plaintext;
  assert.equal(attachment.noteSyncId, 'note-stable');
});

test('kept2 migration plan warns but still carries locked notes', () => {
  const snapshot = createLegacySnapshot({
    notes: [{
      id: 9,
      noteTitle: 'Locked',
      noteBody: '',
      checkBoxes: '[]',
      images: '[]',
      labels: '[]',
      locked: 1,
      lockSalt: 'salt',
      lockHash: 'hash'
    }]
  });
  const plan = createMigrationPlan(snapshot, { vaultId: 'vault-test' });
  assert.equal(plan.warnings[0].code, 'locked-note');
  const content = plan.resources.find(resource => resource.resourceType === 'note.content').plaintext;
  assert.equal(content.locked, true);
  assert.equal(content.lockHash, 'hash');
});
