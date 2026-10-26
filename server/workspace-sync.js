const crypto = require('node:crypto');

function createWorkspaceSync(deps) {
  const { run, get, all, appendSyncChange, normalizeLwwStamp, compareLwwStamp, serverLwwStamp,
    publicUser, noteSyncSnapshot, enrichReminderResponse, parseLocationSavedPlacePayload } = deps;
  const catalogs = { label: 'labels', binder: 'binders', savedPlace: 'location_saved_places' };
  const object = value => JSON.parse(value || 'null');
  const stampOf = row => ({ physicalMs: row.physicalMs, logical: row.logical, deviceId: row.deviceId, operationId: row.operationId });

  async function init() {
    const schema = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_changes'");
    if (!schema.sql.includes("'savedPlace'")) {
      await deps.withDatabaseTransaction(async () => {
        const expanded = schema.sql.replace(/CREATE TABLE(?: IF NOT EXISTS)? sync_changes/i, 'CREATE TABLE sync_changes_upgrade')
          .replace("('note','reminder','attachment')", "('note','reminder','attachment','label','binder','savedPlace','preferences')");
        await run(expanded);
        await run('INSERT INTO sync_changes_upgrade SELECT * FROM sync_changes');
        await run('DROP TABLE sync_changes');
        await run('ALTER TABLE sync_changes_upgrade RENAME TO sync_changes');
        await run('CREATE INDEX sync_changes_user_sequence_idx ON sync_changes(userId,sequence)');
      });
    }

    await run(`CREATE TABLE IF NOT EXISTS binders (id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, UNIQUE(userId, name))`);
    if (!(await all('PRAGMA table_info(binders)')).some(column => column.name === 'sortOrder')) {
      await run('ALTER TABLE binders ADD COLUMN sortOrder INTEGER');
    }
    await run(`CREATE TABLE IF NOT EXISTS workspace_catalog (
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, resourceType TEXT NOT NULL, syncId TEXT NOT NULL, resourceId INTEGER,
      payload TEXT, deleted INTEGER NOT NULL DEFAULT 0, physicalMs INTEGER NOT NULL, logical INTEGER NOT NULL,
      deviceId TEXT NOT NULL, operationId TEXT NOT NULL, PRIMARY KEY(userId,resourceType,syncId))`);
    await run(`CREATE INDEX IF NOT EXISTS workspace_catalog_resource ON workspace_catalog(userId,resourceType,resourceId)`);
    await run(`CREATE TABLE IF NOT EXISTS workspace_operations (userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, operationId TEXT NOT NULL,
      fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(userId,operationId))`);
    await run(`CREATE TABLE IF NOT EXISTS workspace_tombstones (userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, resourceType TEXT NOT NULL,
      syncId TEXT NOT NULL, physicalMs INTEGER NOT NULL, logical INTEGER NOT NULL, deviceId TEXT NOT NULL,
      operationId TEXT NOT NULL, PRIMARY KEY(userId,resourceType,syncId))`);
  }

  async function publish(userId, resourceType, syncId, value, stamp) {
    await run(`INSERT OR REPLACE INTO workspace_catalog
      (userId,resourceType,syncId,resourceId,payload,deleted,physicalMs,logical,deviceId,operationId)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [userId,resourceType,syncId,value?.id || null, value ? JSON.stringify(value) : null,
      value ? 0 : 1,stamp.physicalMs,stamp.logical,stamp.deviceId,stamp.operationId]);
    await appendSyncChange([userId], resourceType, syncId, value ? 'upsert' : 'delete', value, stamp);
  }

  // Capture legacy REST writes too. This runs inside the same database lock as
  // snapshots/change reads, and repairs a missed publication after a crash.
  async function capture(userId) {
    await run("INSERT OR IGNORE INTO binders(userId,name) SELECT DISTINCT ownerUserId,binder FROM notes WHERE ownerUserId = ? AND binder <> ''", [userId]);
    for (const [resourceType, table] of Object.entries(catalogs)) {
      const rows = await all(`SELECT * FROM ${table} WHERE userId = ?`, [userId]);
      const known = await all('SELECT * FROM workspace_catalog WHERE userId = ? AND resourceType = ? AND deleted = 0', [userId,resourceType]);
      const ids = new Set(rows.map(row => row.id));
      for (const row of rows) {
        const aliases = known.filter(item => item.resourceId === row.id);
        if (!aliases.length) aliases.push({syncId:`${resourceType}-${crypto.randomUUID()}`});
        for (const previous of aliases) {
          const value = {...row,syncId:previous.syncId};
          if (!previous.payload || JSON.stringify(value) !== previous.payload) await publish(userId,resourceType,previous.syncId,value,serverLwwStamp());
        }
      }
      for (const row of known) if (!ids.has(row.resourceId)) await publish(userId,resourceType,row.syncId,null,serverLwwStamp());
    }
    const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
    const value = { syncId: 'account-preferences', theme: user.theme || 'light', followSystemTheme: !!user.followSystemTheme, showPastReminders: !!user.showPastReminders };
    const old = await get("SELECT * FROM workspace_catalog WHERE userId = ? AND resourceType = 'preferences'", [userId]);
    if (!old || JSON.stringify(value) !== old.payload) await publish(userId,'preferences',value.syncId,value,serverLwwStamp());
  }

  async function resources(userId) {
    await capture(userId);
    const rows = await all('SELECT * FROM workspace_catalog WHERE userId = ? AND deleted = 0', [userId]);
    return {
      protocolVersion: 2,
      labels: rows.filter(row => row.resourceType === 'label').map(row => object(row.payload)),
      binders: rows.filter(row => row.resourceType === 'binder').map(row => object(row.payload)),
      savedPlaces: rows.filter(row => row.resourceType === 'savedPlace').map(row => object(row.payload)),
      preferences: rows.filter(row => row.resourceType === 'preferences').map(row => object(row.payload))
    };
  }

  async function canonical(userId, type, syncId, result) {
    if (result.deleted) return null;
    if (type === 'note') return result.id ? noteSyncSnapshot(result.id,userId) : null;
    if (type === 'reminder') {
      const row = await get('SELECT * FROM reminders WHERE userId = ? AND syncId = ?', [userId,syncId]);
      return row ? enrichReminderResponse(row) : null;
    }
    if (type === 'attachment') {
      const row = await get('SELECT * FROM note_attachments WHERE syncId = ?', [syncId]);
      return row && await deps.getAccessibleNote(row.noteId,userId) ? deps.attachmentResponse(row) : null;
    }
    return object((await get('SELECT payload FROM workspace_catalog WHERE userId = ? AND resourceType = ? AND syncId = ?', [userId,type,syncId]))?.payload);
  }

  async function catalogMutation(userId, mutation, stamp) {
    const type = mutation.type.split('.')[0];
    const syncId = mutation.syncId;
    const payload = mutation.payload || {};
    const previous = await get('SELECT * FROM workspace_catalog WHERE userId = ? AND resourceType = ? AND syncId = ?', [userId,type,syncId]);
    if (previous && compareLwwStamp(stamp,stampOf(previous)) < 0) return { ok:true, skipped:true, resourceType:type, syncId, canonical:object(previous.payload) };
    if (type === 'preferences') {
      const patch = {};
      for (const key of ['theme','followSystemTheme','showPastReminders']) if (payload[key] !== undefined) patch[key] = payload[key];
      if ((patch.theme !== undefined && !['light','dark'].includes(patch.theme)) || ['followSystemTheme','showPastReminders'].some(key => patch[key] !== undefined && typeof patch[key] !== 'boolean')) return { ok:false, error:'Invalid account preference.' };
      if (Object.keys(patch).length) await run(`UPDATE users SET ${Object.keys(patch).map(key => `${key} = ?`).join(',')} WHERE id = ?`, [...Object.values(patch).map(value => typeof value === 'boolean' ? Number(value) : value),userId]);
      const user = publicUser(await get('SELECT * FROM users WHERE id = ?', [userId]));
      const value = { syncId, theme:user.theme, followSystemTheme:user.followSystemTheme, showPastReminders:user.showPastReminders };
      await publish(userId,type,syncId,value,stamp);
      return { ok:true, resourceType:type,syncId,canonical:value };
    }
    const table = catalogs[type];
    if (!table) return { ok:false,error:'Unsupported catalog resource.' };
    const row = previous?.resourceId ? await get(`SELECT * FROM ${table} WHERE id = ? AND userId = ?`, [previous.resourceId,userId]) : null;
    if (mutation.type.endsWith('.delete')) {
      if (row) {
        if (type === 'binder') {
          const notes = await all('SELECT id FROM notes WHERE ownerUserId = ? AND binder = ?', [userId,row.name]);
          await run("UPDATE notes SET binder = '' WHERE ownerUserId = ? AND binder = ?", [userId,row.name]);
          for (const note of notes) await deps.recordNoteSyncChange(note.id,'upsert');
        }
        if (type === 'label') {
          await deps.updateNoteLabelReferencesForUser(userId,row.id,'',{ oldName:row.name });
        }
        await run(`DELETE FROM ${table} WHERE id = ? AND userId = ?`, [row.id,userId]);
      }
      if (row) for (const alias of await all('SELECT syncId FROM workspace_catalog WHERE userId = ? AND resourceType = ? AND resourceId = ? AND syncId <> ?', [userId,type,row.id,syncId])) await publish(userId,type,alias.syncId,null,stamp);
      await publish(userId,type,syncId,null,stamp);
      return { ok:true,resourceType:type,syncId,deleted:true,canonical:null };
    }
    let id = row?.id;
    if (type === 'savedPlace') {
      const value = parseLocationSavedPlacePayload(payload,row || {});
      if (value.error) return { ok:false,error:value.error };
      const fields=['name','address','placeType','latitude','longitude','radiusMeters','locationTrigger','mapPreviewUrl'];
      const now=new Date().toISOString();
      if (id) await run(`UPDATE ${table} SET ${fields.map(key => `${key} = ?`).join(',')},updatedAt = ? WHERE id = ? AND userId = ?`, [...fields.map(key=>value[key]),now,id,userId]);
      else id=(await run(`INSERT INTO ${table}(userId,${fields.join(',')},createdAt,updatedAt) VALUES(${Array(fields.length+3).fill('?').join(',')})`, [userId,...fields.map(key=>value[key]),now,now])).id;
    } else {
      const name = String(payload.name || '').trim().slice(0,80);
      if (!name) return { ok:false,error:'A name is required.' };
      if (type === 'binder' && payload.sortOrder !== undefined && payload.sortOrder !== null &&
          (!Number.isSafeInteger(payload.sortOrder) || payload.sortOrder < 0)) {
        return { ok:false,error:'Invalid binder order.' };
      }
      const duplicate = await get(`SELECT * FROM ${table} WHERE userId = ? AND lower(name) = lower(?)`, [userId,name]);
      if (duplicate && id && duplicate.id !== id) return { ok:false,error:'That name is already in use.' };
      if (id) await run(`UPDATE ${table} SET name = ? WHERE id = ? AND userId = ?`, [name,id,userId]);
      else if (duplicate) id=duplicate.id;
      else id=(await run(`INSERT INTO ${table}(userId,name) VALUES(?,?)`, [userId,name])).id;
      if (type === 'binder' && payload.sortOrder !== undefined) {
        await run('UPDATE binders SET sortOrder = ? WHERE id = ? AND userId = ?', [payload.sortOrder,id,userId]);
      }
      if (type === 'label' && row && row.name !== name) await deps.updateNoteLabelReferencesForUser(userId,row.id,name,{ oldName:row.name });
      if (type === 'binder' && row && row.name !== name) {
        const notes = await all('SELECT id FROM notes WHERE ownerUserId = ? AND binder = ?', [userId,row.name]);
        await run('UPDATE notes SET binder = ? WHERE ownerUserId = ? AND binder = ?', [name,userId,row.name]);
        for (const note of notes) await deps.recordNoteSyncChange(note.id,'upsert');
      }
    }
    const value = { ...await get(`SELECT * FROM ${table} WHERE id = ? AND userId = ?`, [id,userId]), syncId };
    const aliases = await all('SELECT * FROM workspace_catalog WHERE userId = ? AND resourceType = ? AND resourceId = ?', [userId,type,id]);
    const effectiveStamp = aliases.reduce((latest,alias)=>compareLwwStamp(latest,stampOf(alias)) < 0 ? stampOf(alias) : latest,stamp);
    await publish(userId,type,syncId,value,effectiveStamp);
    for (const alias of aliases.filter(alias=>alias.syncId !== syncId)) await publish(userId,type,alias.syncId,{...value,syncId:alias.syncId},effectiveStamp);
    return { ok:true,resourceType:type,syncId,id,canonical:value };
  }

  // Must be called inside the existing operation's SQLite transaction.
  async function apply(userId, mutation, core) {
    const allowed = new Set(['note.upsert','note.delete','note.view-state','note.reorder','reminder.upsert','reminder.delete','reminder.occurrence','reminder.action','attachment.delete','label.upsert','label.delete','binder.upsert','binder.delete','savedPlace.upsert','savedPlace.delete','preferences.patch']);
    if (!allowed.has(mutation.type)) return {ok:false,error:'Unsupported mutation type.'};
    const operationId = mutation.operationId || mutation.lww?.operationId;
    if (typeof operationId !== 'string' || !operationId || operationId.length > 160) return { ok:false,error:'A valid operationId is required.' };
    if (!mutation.syncId || typeof mutation.syncId !== 'string' || mutation.syncId.length > 160) return { ok:false,operationId,error:'A valid resource identity is required.' };
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ type:mutation.type,syncId:mutation.syncId,payload:mutation.payload,lww:mutation.lww })).digest('hex');
    const receipt = await get('SELECT * FROM workspace_operations WHERE userId = ? AND operationId = ?', [userId,operationId]);
    if (receipt) return receipt.fingerprint === fingerprint ? object(receipt.result) : { ok:false,operationId,error:'An operationId cannot be reused for different content.' };
    const stamp=normalizeLwwStamp(mutation.lww || {});
    const type=mutation.type.split('.')[0];
    const tombstone=await get('SELECT * FROM workspace_tombstones WHERE userId = ? AND resourceType = ? AND syncId = ?', [userId,type,mutation.syncId]);
    let result;
    if (tombstone && !mutation.type.endsWith('.delete') && compareLwwStamp(stamp,stampOf(tombstone)) <= 0) {
      result={ok:true,skipped:true,resourceType:type,syncId:mutation.syncId,canonical:null};
    } else {
      result = catalogs[type] || type === 'preferences' ? await catalogMutation(userId,mutation,stamp) : await core();
      if (result.ok && result.canonical === undefined && mutation.type !== 'note.reorder') result.canonical=await canonical(userId,type,mutation.syncId,result);
      if (result.ok && result.canonical === null && mutation.type.endsWith('.delete') && (!tombstone || compareLwwStamp(stamp,stampOf(tombstone)) >= 0)) await run(`INSERT OR REPLACE INTO workspace_tombstones
        (userId,resourceType,syncId,physicalMs,logical,deviceId,operationId) VALUES(?,?,?,?,?,?,?)`, [userId,type,mutation.syncId,stamp.physicalMs,stamp.logical,stamp.deviceId,stamp.operationId]);
    }
    result={...result,operationId};
    if (result.ok) await run('INSERT INTO workspace_operations(userId,operationId,fingerprint,result) VALUES(?,?,?,?)', [userId,operationId,fingerprint,JSON.stringify(result)]);
    return result;
  }
  return { init,capture,resources,apply };
}
module.exports={ createWorkspaceSync };
