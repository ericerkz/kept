// Additive protocol support for clients with a durable local database.
async function initNativeClientSchema({ run, get, all }) {
  const noteColumns = await all('PRAGMA table_info(notes)');
  if (!noteColumns.some(column => column.name === 'revision')) {
    await run('ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  // Cover legacy/web/AI writes too. The revision-only update does not recurse.
  await run(`CREATE TRIGGER IF NOT EXISTS notes_revision_updated
    AFTER UPDATE ON notes WHEN NEW.revision = OLD.revision
    BEGIN UPDATE notes SET revision = OLD.revision + 1 WHERE id = NEW.id; END`);

  const indexes = await all('PRAGMA index_list(reminders)');
  let hasGlobalNoteIndex = false;
  for (const index of indexes.filter(item => item.unique)) {
    const columns = await all(`PRAGMA index_info("${index.name.replace(/"/g, '""')}")`);
    if (columns.length === 1 && columns[0].name === 'noteId') hasGlobalNoteIndex = true;
  }
  if (hasGlobalNoteIndex) {
    // This runs at startup, before requests or the reminder scheduler begin.
    const schema = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reminders'");
    const columns = await all('PRAGMA table_info(reminders)');
    const names = columns.map(column => `"${column.name}"`).join(', ');
    const tableSql = schema.sql.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+["`\[]?reminders["`\]]?/i, 'CREATE TABLE reminders_native_migration')
      .replace(/noteId INTEGER UNIQUE/i, 'noteId INTEGER');
    if (tableSql === schema.sql || /noteId INTEGER UNIQUE/i.test(tableSql)) throw new Error('Unexpected reminder schema; migration aborted.');
    await run('BEGIN IMMEDIATE');
    try {
      await run(tableSql);
      await run(`INSERT INTO reminders_native_migration (${names}) SELECT ${names} FROM reminders`);
      await run('DROP TABLE reminders');
      await run('ALTER TABLE reminders_native_migration RENAME TO reminders');
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }
  await run('CREATE UNIQUE INDEX IF NOT EXISTS reminders_user_note_unique ON reminders(userId, noteId)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS reminders_sync_id_unique ON reminders(syncId)');
  await run('CREATE INDEX IF NOT EXISTS reminders_user_idx ON reminders(userId)');
  await run('CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(dueAtUtc, status)');
  const reminderColumns = await all('PRAGMA table_info(reminders)');
  if (!reminderColumns.some(column => column.name === 'scheduleVersion')) {
    await run('ALTER TABLE reminders ADD COLUMN scheduleVersion INTEGER NOT NULL DEFAULT 1');
  }
  if (!reminderColumns.some(column => column.name === 'scheduleAnchorAtUtc')) {
    await run('ALTER TABLE reminders ADD COLUMN scheduleAnchorAtUtc TEXT');
  }
  await run('DROP TRIGGER IF EXISTS reminder_schedule_updated');
  await run('UPDATE reminders SET scheduleAnchorAtUtc = dueAtUtc WHERE scheduleAnchorAtUtc IS NULL AND dueAtUtc IS NOT NULL');
  await run(`CREATE TABLE IF NOT EXISTS native_mutation_results (
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operationId TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
    createdAt TEXT NOT NULL, PRIMARY KEY(userId, operationId))`);
  await run(`CREATE TABLE IF NOT EXISTS reminder_occurrences (
    occurrenceId TEXT PRIMARY KEY, userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reminderSyncId TEXT NOT NULL, dueAtUtc TEXT NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', snoozeUntil TEXT, createdAt TEXT NOT NULL)`);
  await run('CREATE INDEX IF NOT EXISTS reminder_occurrences_user_due ON reminder_occurrences(userId, dueAtUtc)');
  await run(`CREATE TABLE IF NOT EXISTS native_upload_receipts (
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operationId TEXT NOT NULL,
    resourceType TEXT NOT NULL CHECK(resourceType IN ('image', 'attachment')),
    resourceSyncId TEXT NOT NULL,
    noteId INTEGER,
    contentHash TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'deleted')),
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY(userId, operationId),
    UNIQUE(userId, resourceType, resourceSyncId))`);
}

function occurrenceId(reminder) {
  return `${reminder.syncId}@${new Date(reminder.dueAtUtc).toISOString()}#v${Number(reminder.scheduleVersion || 1)}`;
}

module.exports = { initNativeClientSchema, occurrenceId };
