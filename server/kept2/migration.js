const crypto = require('crypto');

const LEGACY_PROTOCOL_VERSION = '1.8.1';

function createLegacySnapshot(input = {}) {
  const snapshot = {
    sourceVersion: input.sourceVersion || LEGACY_PROTOCOL_VERSION,
    createdAt: input.createdAt || new Date().toISOString(),
    notes: normalizeRows(input.notes),
    reminders: normalizeRows(input.reminders),
    attachments: normalizeRows(input.attachments),
    noteImages: normalizeRows(input.noteImages),
    labels: normalizeRows(input.labels),
    collaborators: normalizeRows(input.collaborators)
  };
  const hash = sha256(stableJson(snapshot));
  return {
    ...snapshot,
    snapshotId: `legacy-${hash.slice(0, 24)}`,
    snapshotHash: hash,
    counts: {
      notes: snapshot.notes.length,
      reminders: snapshot.reminders.length,
      attachments: snapshot.attachments.length,
      noteImages: snapshot.noteImages.length,
      labels: snapshot.labels.length,
      collaborators: snapshot.collaborators.length
    }
  };
}

function createMigrationPlan(snapshot, options = {}) {
  const vaultId = options.vaultId || `vault-${crypto.randomUUID()}`;
  const deviceId = options.deviceId || 'migration';
  const createdAt = options.createdAt || new Date().toISOString();
  const resources = [];
  const warnings = [];
  const noteSyncIds = new Map();

  for (const note of snapshot.notes || []) {
    const syncId = modernResourceId(note, 'note');
    noteSyncIds.set(Number(note.id), syncId);
    if (note.locked) warnings.push({ code: 'locked-note', legacyId: note.id, syncId });
    resources.push({
      resourceId: syncId,
      resourceType: 'note.content',
      keyPurpose: 'note',
      lww: migrationLww(note, deviceId),
      plaintext: legacyNoteContent(note)
    });
    resources.push({
      resourceId: `${syncId}:owner`,
      resourceType: 'note.ownerState',
      keyPurpose: 'note',
      lww: migrationLww(note, deviceId),
      plaintext: legacyOwnerState(note)
    });
  }

  for (const reminder of snapshot.reminders || []) {
    const noteSyncId = noteSyncIds.get(Number(reminder.noteId)) || modernResourceId({ id: reminder.noteId }, 'note');
    resources.push({
      resourceId: modernResourceId(reminder, 'reminder'),
      resourceType: 'reminder',
      keyPurpose: 'reminder',
      lww: migrationLww(reminder, deviceId),
      plaintext: {
        ...preserveUnknown(reminder, [
          'id', 'syncId', 'noteId', 'title', 'body', 'dueAt', 'status', 'kind', 'createdAt', 'updatedAt'
        ]),
        legacyId: reminder.id,
        noteSyncId,
        title: reminder.title || '',
        body: reminder.body || '',
        dueAt: reminder.dueAt || null,
        status: reminder.status || 'pending',
        kind: reminder.kind || 'time',
        createdAt: reminder.createdAt || createdAt,
        updatedAt: reminder.updatedAt || reminder.createdAt || createdAt
      }
    });
  }

  for (const attachment of snapshot.attachments || []) {
    const noteSyncId = noteSyncIds.get(Number(attachment.noteId)) || modernResourceId({ id: attachment.noteId }, 'note');
    resources.push({
      resourceId: modernResourceId(attachment, 'attachment'),
      resourceType: 'attachment',
      keyPurpose: 'attachment',
      lww: migrationLww(attachment, deviceId),
      plaintext: {
        ...preserveUnknown(attachment, [
          'id', 'syncId', 'noteId', 'originalName', 'storedFilename', 'fileSize', 'mimeType', 'uploadedAt'
        ]),
        legacyId: attachment.id,
        noteSyncId,
        originalName: attachment.originalName || '',
        storedFilename: attachment.storedFilename || '',
        fileSize: Number(attachment.fileSize || 0),
        mimeType: attachment.mimeType || 'application/octet-stream',
        uploadedAt: attachment.uploadedAt || createdAt
      }
    });
  }

  resources.push({
    resourceId: `migration-backup:${snapshot.snapshotId}`,
    resourceType: 'migrationBackup',
    keyPurpose: 'backup',
    lww: {
      physicalMs: Date.parse(createdAt) || Date.now(),
      logical: 0,
      deviceId,
      operationId: `migration-backup-${snapshot.snapshotId}`
    },
    plaintext: {
      sourceVersion: snapshot.sourceVersion,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      counts: snapshot.counts
    }
  });

  return {
    vaultId,
    createdAt,
    sourceVersion: snapshot.sourceVersion,
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    resources,
    warnings
  };
}

function legacyNoteContent(note) {
  return {
    ...preserveUnknown(note, [
      'id', 'syncId', 'ownerUserId', 'noteTitle', 'noteBody', 'checkBoxes', 'images',
      'isCbox', 'labels', 'binder', 'locked', 'lockSalt', 'lockHash', 'createdAt', 'updatedAt'
    ]),
    legacyId: note.id,
    title: note.noteTitle || '',
    body: note.noteBody || '',
    checkBoxes: parseMaybeJson(note.checkBoxes, []),
    images: parseMaybeJson(note.images, []),
    isChecklist: Boolean(note.isCbox),
    labels: parseMaybeJson(note.labels, []),
    binder: note.binder || '',
    locked: Boolean(note.locked),
    lockSalt: note.lockSalt || '',
    lockHash: note.lockHash || '',
    createdAt: note.createdAt || new Date(0).toISOString(),
    updatedAt: note.updatedAt || note.createdAt || new Date(0).toISOString()
  };
}

function legacyOwnerState(note) {
  return {
    legacyId: note.id,
    ownerUserId: note.ownerUserId || null,
    pinned: Boolean(note.pinned),
    archived: Boolean(note.archived),
    trashed: Boolean(note.trashed),
    trashedAt: note.trashedAt || null,
    sortOrder: Number(note.sortOrder || note.id || 0),
    bgColor: note.bgColor || '',
    bgImage: note.bgImage || '',
    completedChecklistCollapsed: Boolean(note.completedChecklistCollapsed),
    isDemo: Boolean(note.isDemo)
  };
}

function migrationLww(row, deviceId) {
  return {
    physicalMs: Number(row.lwwPhysicalMs || Date.parse(row.updatedAt || row.createdAt || '') || Date.now()),
    logical: Number(row.lwwLogical || 0),
    deviceId: row.lwwDeviceId || deviceId,
    operationId: row.lwwOperationId || `migration-${modernResourceId(row, 'resource')}`
  };
}

function modernResourceId(row, prefix) {
  if (row?.syncId && /^[A-Za-z0-9._:-]{1,180}$/.test(String(row.syncId))) return String(row.syncId);
  return `${prefix}-${row?.id || crypto.randomUUID()}`;
}

function preserveUnknown(row, knownKeys) {
  const known = new Set(knownKeys);
  const unknown = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (!known.has(key)) unknown[key] = parseMaybeJson(value, value);
  }
  return Object.keys(unknown).length ? { unknownLegacyFields: unknown } : {};
}

function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({ ...row }));
}

function parseMaybeJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
  createLegacySnapshot,
  createMigrationPlan,
  stableJson
};
