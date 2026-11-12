// note_collaborators remains the effective access index used by REST, sync,
// files and reminders. Track direct access separately from binder membership.
function createBinderSharing({ run, get, all, appendSyncChange, serverLwwStamp, compareLwwStamp, broadcastRealtime, moveNoteToTopForUsers, recordAttachmentSyncChange, recordReminderSyncChange }) {
  async function init() {
    await run(`CREATE TABLE IF NOT EXISTS binders (id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, UNIQUE(userId,name))`);
    const columns = await all('PRAGMA table_info(note_collaborators)');
    if (!columns.some(column => column.name === 'directShare')) {
      await run('ALTER TABLE note_collaborators ADD COLUMN directShare INTEGER NOT NULL DEFAULT 1');
    }
    await run(`CREATE TABLE IF NOT EXISTS binder_members (
      binderId INTEGER NOT NULL REFERENCES binders(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(binderId,userId))`);
    await run('CREATE INDEX IF NOT EXISTS binder_members_user ON binder_members(userId,binderId)');
    await run(`CREATE TABLE IF NOT EXISTS binder_note_grants (
      binderId INTEGER NOT NULL REFERENCES binders(id) ON DELETE CASCADE,
      noteId INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(noteId,userId))`);
    await run('CREATE INDEX IF NOT EXISTS binder_note_grants_binder ON binder_note_grants(binderId,noteId)');
    await run(`CREATE TABLE IF NOT EXISTS binder_notes (
      noteId INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      binderId INTEGER REFERENCES binders(id) ON DELETE SET NULL,
      binderName TEXT NOT NULL DEFAULT '', explicit INTEGER NOT NULL DEFAULT 0,
      stamp TEXT NOT NULL DEFAULT '{}')`);
    await run('CREATE INDEX IF NOT EXISTS binder_notes_binder ON binder_notes(binderId,noteId)');
    await run(`INSERT OR IGNORE INTO binder_notes(noteId,binderId,binderName)
      SELECT n.id,b.id,n.binder FROM notes n JOIN binders b ON b.userId=n.ownerUserId AND lower(b.name)=lower(n.binder)`);
  }

  function fields(userId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid binder viewer.');
    return `(SELECT json_object('id',b.id,'name',b.name,'ownerUserId',b.userId,
      'ownerDisplayName',u.displayName,'ownerUsername',u.username)
      FROM binder_notes g JOIN binders b ON b.id = g.binderId JOIN users u ON u.id = b.userId
      WHERE g.noteId = notes.id AND (b.userId <> ${id} OR notes.ownerUserId <> b.userId)
        AND (notes.ownerUserId=${id} OR b.userId=${id} OR EXISTS(SELECT 1 FROM binder_members m WHERE m.binderId=b.id AND m.userId=${id}))) AS sharedBinderJson`;
  }

  async function isMember(binderId,userId) {
    return !!await get(`SELECT b.id FROM binders b WHERE b.id=? AND (b.userId=? OR EXISTS
      (SELECT 1 FROM binder_members m WHERE m.binderId=b.id AND m.userId=?))`,[binderId,userId,userId]);
  }
  async function canTrash(noteId,userId) {
    const link=await get('SELECT binderId FROM binder_notes WHERE noteId=?',[noteId]);
    return !!link?.binderId && await isMember(link.binderId,userId);
  }
  async function preserveBinder(noteId) {
    return !!(await get('SELECT explicit FROM binder_notes WHERE noteId=?',[noteId]))?.explicit;
  }
  async function move(noteId,userId,binderId,stamp=serverLwwStamp(),binderName) {
    const note=await get('SELECT id,ownerUserId,binder FROM notes WHERE id=?',[noteId]);
    const previous=await get('SELECT * FROM binder_notes WHERE noteId=?',[noteId]);
    if (!note || (note.ownerUserId!==userId && !await canTrash(noteId,userId))) {
      throw Object.assign(new Error('Note not found.'),{status:404});
    }
    if (binderId===undefined && typeof binderName==='string' && note.ownerUserId===userId) {
      const name=binderName.trim().slice(0,80);
      if (name) {
        await run('INSERT OR IGNORE INTO binders(userId,name) VALUES(?,?)',[userId,name]);
        binderId=(await get('SELECT id FROM binders WHERE userId=? AND lower(name)=lower(?)',[userId,name])).id;
      } else binderId=null;
    }
    if (binderId!==null && (!Number.isSafeInteger(binderId) || binderId<=0 || !await isMember(binderId,userId))) {
      throw Object.assign(new Error('Binder not found.'),{status:404});
    }
    // Only a note's owner may grant a new audience access to it.
    if (binderId!==null && binderId!==previous?.binderId && note.ownerUserId!==userId) {
      throw Object.assign(new Error('Only the note owner can add it to another binder.'),{status:403});
    }
    if (previous && compareLwwStamp(stamp,JSON.parse(previous.stamp))<0) return false;
    const binder=binderId===null ? null : await get('SELECT name FROM binders WHERE id=?',[binderId]);
    await run(`INSERT INTO binder_notes(noteId,binderId,binderName,explicit,stamp) VALUES(?,?,?,1,?)
      ON CONFLICT(noteId) DO UPDATE SET binderId=excluded.binderId,binderName=excluded.binderName,explicit=1,stamp=excluded.stamp`,
    [noteId,binderId,binder?.name || '',JSON.stringify(stamp)]);
    await run('UPDATE notes SET binder=? WHERE id=?',[binder?.name || '',noteId]);
    return true;
  }
  async function rename(binderId,name) {
    const notes=await all('SELECT noteId AS id FROM binder_notes WHERE binderId=?',[binderId]);
    await run('UPDATE notes SET binder=? WHERE id IN (SELECT noteId FROM binder_notes WHERE binderId=?)',[name,binderId]);
    await run('UPDATE binder_notes SET binderName=? WHERE binderId=?',[name,binderId]);
    return notes;
  }
  async function detach(binderId) {
    const notes=await rename(binderId,'');
    await run("UPDATE binder_notes SET binderId=NULL,explicit=1,stamp=? WHERE binderId=?",[JSON.stringify(serverLwwStamp()),binderId]);
    return notes;
  }

  async function memberIds(binderId) {
    return (await all('SELECT userId FROM binder_members WHERE binderId = ?', [binderId])).map(row => row.userId);
  }

  async function rowsFor(userId) {
    const rows = await all(`SELECT b.id,b.userId,b.name,b.sortOrder,u.displayName AS ownerDisplayName,u.username AS ownerUsername,
      (SELECT COUNT(*) FROM binder_members m WHERE m.binderId = b.id) AS memberCount
      FROM binders b JOIN users u ON u.id = b.userId WHERE b.userId = ? OR EXISTS
      (SELECT 1 FROM binder_members m WHERE m.binderId = b.id AND m.userId = ?)`, [userId,userId]);
    return rows.map(({ownerDisplayName,ownerUsername,...row}) => row.userId === userId ? row : {
      ...row,shared:true,ownerUserId:row.userId,ownerDisplayName,ownerUsername
    });
  }

  async function reconcileNote(noteId) {
    const note = await get('SELECT id,syncId,ownerUserId,binder FROM notes WHERE id = ?', [noteId]);
    if (!note) return [];
    let link=await get('SELECT * FROM binder_notes WHERE noteId=?',[noteId]);
    if (!link || (!link.explicit && (link.binderName!==note.binder || (!link.binderId && note.binder)))) {
      const binder=await get('SELECT id FROM binders WHERE userId=? AND lower(name)=lower(?)',[note.ownerUserId,note.binder]);
      await run(`INSERT INTO binder_notes(noteId,binderId,binderName) VALUES(?,?,?) ON CONFLICT(noteId)
        DO UPDATE SET binderId=excluded.binderId,binderName=excluded.binderName`,[noteId,binder?.id || null,note.binder]);
      link={binderId:binder?.id};
    }
    const expected = link?.binderId ? await all(`SELECT b.id AS binderId,u.id AS userId FROM binders b JOIN users u
      ON u.id=b.userId OR EXISTS(SELECT 1 FROM binder_members m WHERE m.binderId=b.id AND m.userId=u.id)
      WHERE b.id=? AND u.id<>?`,[link.binderId,note.ownerUserId]) : [];
    const previous = await all('SELECT binderId,userId FROM binder_note_grants WHERE noteId = ?', [noteId]);
    const before = await all('SELECT userId,directShare FROM note_collaborators WHERE noteId = ?', [noteId]);
    const expectedUsers = new Set(expected.map(row => row.userId));
    const changed = previous.length !== expected.length || previous.some(row => !expected.some(next => next.userId === row.userId && next.binderId === row.binderId));
    if (!changed && expected.every(row => before.some(old => old.userId === row.userId))
      && !before.some(row => !row.directShare && !expectedUsers.has(row.userId))) return [];
    if (changed) {
      await run('DELETE FROM binder_note_grants WHERE noteId = ?', [noteId]);
      for (const row of expected) await run('INSERT INTO binder_note_grants(binderId,noteId,userId) VALUES(?,?,?)', [row.binderId,noteId,row.userId]);
    }
    for (const row of expected) await run(`INSERT OR IGNORE INTO note_collaborators(noteId,userId,createdAt,directShare)
      VALUES(?,?,?,0)`, [noteId,row.userId,new Date().toISOString()]);
    const removed = before.filter(row => !row.directShare && !expectedUsers.has(row.userId)).map(row => row.userId);
    for (const userId of removed) {
      await run('DELETE FROM note_collaborators WHERE noteId = ? AND userId = ?', [noteId,userId]);
      await run('DELETE FROM note_collaborator_rejoin_grants WHERE noteId = ? AND userId = ?', [noteId,userId]);
    }
    if (removed.length && note.syncId) {
      const stamp = serverLwwStamp();
      // Remove retained snapshots too: an old cursor must never retrieve content
      // after access is revoked, even before it reaches this deletion event.
      for (const userId of removed) await run(`DELETE FROM sync_changes
        WHERE userId = ? AND resourceType = 'note' AND resourceSyncId = ?`, [userId,note.syncId]);
      await appendSyncChange(removed,'note',note.syncId,'delete',null,stamp);
      for (const file of await all('SELECT syncId FROM note_attachments WHERE noteId = ?', [noteId])) {
        if (file.syncId) await appendSyncChange(removed,'attachment',file.syncId,'delete',null,stamp);
      }
      for (const reminder of await all('SELECT userId,syncId FROM reminders WHERE noteId = ?', [noteId])) {
        if (reminder.syncId && removed.includes(reminder.userId)) await appendSyncChange([reminder.userId],'reminder',reminder.syncId,'delete',null,stamp);
      }
      broadcastRealtime(removed,{ type:'notes-changed',action:'access-revoked',noteId,syncId:note.syncId });
    }
    const added = expected.filter(row => !before.some(old => old.userId === row.userId)).map(row => row.userId);
    if (added.length) {
      for (const file of await all('SELECT * FROM note_attachments WHERE noteId = ?', [noteId])) await recordAttachmentSyncChange(file,'upsert',added);
      for (const reminder of await all('SELECT * FROM reminders WHERE noteId = ?', [noteId])) {
        if (added.includes(reminder.userId)) await recordReminderSyncChange(reminder);
      }
    }
    await moveNoteToTopForUsers(noteId,added);
    const affected = [...new Set([...(changed ? [...previous,...expected].map(row => row.userId) : []),...added])];
    if (affected.length) broadcastRealtime(affected,{ type:'notes-changed',action:'updated',noteId });
    return affected;
  }

  async function replaceMembers(binder, userIds) {
    if (!Array.isArray(userIds) || userIds.length > 1000 || userIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw Object.assign(new Error('Choose valid people to share this binder with.'), { status:400 });
    }
    const next = [...new Set(userIds)].filter(id => id !== binder.userId);
    for (const id of next) if (!await get('SELECT id FROM users WHERE id = ? AND enabled = 1', [id])) {
      throw Object.assign(new Error('A selected person is unavailable.'), { status:400 });
    }
    const previous = await memberIds(binder.id);
    await run('DELETE FROM binder_members WHERE binderId = ?', [binder.id]);
    for (const id of next) await run('INSERT INTO binder_members(binderId,userId) VALUES(?,?)', [binder.id,id]);
    return [...new Set([...previous,...next,binder.userId])];
  }

  return { init, fields, rowsFor, memberIds, reconcileNote, replaceMembers,move,canTrash,preserveBinder,rename,detach };
}
module.exports = { createBinderSharing };
