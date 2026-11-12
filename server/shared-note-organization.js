// The note keeps the owner's organization. Recipients' choices are separate
// and become visible only when they opt out of inheriting that field.
function createSharedNoteOrganization(deps) {
  const { run, get, all, compareLwwStamp, serverLwwStamp, normalizeLabelsForUser } = deps;
  const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
  async function init() {
    return deps.withDatabaseTransaction(async () => {
      const columns = await all('PRAGMA table_info(users)');
      for (const field of ['inheritSharedLabels', 'inheritSharedBinders']) {
        if (!columns.some(column => column.name === field)) await run(`ALTER TABLE users ADD COLUMN ${field} INTEGER NOT NULL DEFAULT 1`);
      }
      const existing = await get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_note_organization'");
      await run(`CREATE TABLE IF NOT EXISTS user_note_organization (
        userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        noteId INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        labels TEXT NOT NULL DEFAULT '[]', binder TEXT NOT NULL DEFAULT '',
        labelsStamp TEXT NOT NULL DEFAULT '{}', binderStamp TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(userId, noteId))`);
      // Existing offline clients need organization metadata even if no one edits
      // their shared notes after upgrading the server.
      if (!existing) {
        const shared = await all('SELECT noteId,userId FROM note_collaborators');
        for (const row of shared) await deps.recordNoteSyncChange(row.noteId, 'upsert', [row.userId]);
      }
    });
  }
  function fields(userId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid organization viewer.');
    const personal = field => `(SELECT ${field} FROM user_note_organization WHERE userId = ${id} AND noteId = notes.id)`;
    return `${deps.binderSharing.fields(id)}, ${id} AS organizationViewerId,
      ${personal('labels')} AS personalLabels, ${personal('binder')} AS personalBinder,
      CASE WHEN notes.ownerUserId = ${id} OR COALESCE((SELECT inheritSharedLabels FROM users WHERE id = ${id}), 1) = 1
        THEN notes.labels ELSE COALESCE(${personal('labels')}, '[]') END AS visibleLabels,
      CASE WHEN notes.ownerUserId = ${id} OR COALESCE((SELECT inheritSharedBinders FROM users WHERE id = ${id}), 1) = 1
        THEN notes.binder ELSE COALESCE(${personal('binder')}, '') END AS visibleBinder`;
  }
  function project(row) {
    if (row.organizationViewerId === undefined) return row;
    const sharedOrganization = row.ownerUserId !== row.organizationViewerId ? {
      ownerLabels: parse(row.labels, []).filter(label => label?.added === true), ownerBinder: row.binder || '',
      personalLabels: parse(row.personalLabels, []), personalBinder: row.personalBinder || ''
    } : undefined;
    return { ...row, labels: row.visibleLabels, binder: row.visibleBinder, sharedOrganization, sharedBinder: parse(row.sharedBinderJson, null) || undefined };
  }
  async function update(userId, noteId, payload, stamp = serverLwwStamp()) {
    const note = await deps.getAccessibleNote(noteId, userId);
    if (!note || note.ownerUserId === userId) return { ok: false, status: 404, error: 'Shared note not found.' };
    if (payload.labels !== undefined && (!Array.isArray(payload.labels) || payload.labels.some(label => !label || typeof label.name !== 'string'))) {
      return { ok: false, status: 400, error: 'Labels must be a list of named labels.' };
    }
    if (payload.binder !== undefined && typeof payload.binder !== 'string') return { ok: false, status: 400, error: 'Binder must be a name.' };
    await run('INSERT OR IGNORE INTO user_note_organization(userId,noteId) VALUES(?,?)', [userId,noteId]);
    const previous = await get('SELECT * FROM user_note_organization WHERE userId = ? AND noteId = ?', [userId,noteId]);
    let changed = false;
    for (const field of ['labels', 'binder']) {
      if (payload[field] === undefined || compareLwwStamp(stamp, parse(previous[`${field}Stamp`], {})) < 0) continue;
      const value = field === 'labels'
        ? JSON.stringify((await normalizeLabelsForUser(userId, payload.labels)).labels.filter(label => label.added))
        : payload.binder.trim().slice(0,80);
      await run(`UPDATE user_note_organization SET ${field} = ?, ${field}Stamp = ? WHERE userId = ? AND noteId = ?`, [value,JSON.stringify(stamp),userId,noteId]);
      changed = true;
    }
    if (changed) {
      await deps.recordNoteSyncChange(noteId, 'upsert', [userId]);
      deps.broadcastRealtime([userId], { type: 'notes-changed', action: 'updated', noteId });
    }
    return { ok: true, resourceType: 'note', syncId: note.syncId, id: noteId };
  }
  async function renameBinder(userId, oldName, name, stamp = serverLwwStamp()) {
    const rows = await all('SELECT noteId FROM user_note_organization WHERE userId = ? AND binder = ?', [userId,oldName]);
    await run('UPDATE user_note_organization SET binder = ?, binderStamp = ? WHERE userId = ? AND binder = ?', [name,JSON.stringify(stamp),userId,oldName]);
    for (const row of rows) await deps.recordNoteSyncChange(row.noteId, 'upsert', [userId]);
  }
  async function renameLabel(userId, labelId, name, oldName, stamp = serverLwwStamp()) {
    const rows = await all('SELECT noteId, labels FROM user_note_organization WHERE userId = ?', [userId]);
    for (const row of rows) {
      const labels = parse(row.labels, []);
      const next = labels.flatMap(label => Number(label.id) === Number(labelId) || (oldName && label.name.toLowerCase() === oldName.toLowerCase())
        ? name ? [{ ...label, id: labelId, name }] : [] : [label]);
      if (JSON.stringify(labels) === JSON.stringify(next)) continue;
      await run('UPDATE user_note_organization SET labels = ?, labelsStamp = ? WHERE userId = ? AND noteId = ?', [JSON.stringify(next),JSON.stringify(stamp),userId,row.noteId]);
      await deps.recordNoteSyncChange(row.noteId, 'upsert', [userId]);
    }
  }
  async function preferencesChanged(userId, patch) {
    if (!['inheritSharedLabels','inheritSharedBinders'].some(key => patch[key] !== undefined)) return;
    const rows = await all('SELECT noteId FROM note_collaborators WHERE userId = ?', [userId]);
    for (const row of rows) await deps.recordNoteSyncChange(row.noteId, 'upsert', [userId]);
    deps.broadcastRealtime([userId], { type: 'notes-changed', action: 'updated' });
  }
  return { init, fields, project, update, renameBinder, renameLabel, preferencesChanged };
}
module.exports = { createSharedNoteOrganization };
