const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Imports are private to their authenticated owner. No live notes are changed
// until a sealed, verified job is committed in one SQLite transaction.
function createWorkspaceImport(d) {
  const { run, get, all, withDatabaseTransaction: transaction } = d;
  const directory = path.join(d.dataDir, 'imports', 'workspaces');
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  async function init() {
    fs.mkdirSync(directory, { recursive: true });
    await run(`CREATE TABLE IF NOT EXISTS workspace_imports (id TEXT PRIMARY KEY, userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sourceId TEXT NOT NULL, generation TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'uploading', manifest TEXT, result TEXT, createdAt TEXT NOT NULL)`);
    await run('CREATE UNIQUE INDEX IF NOT EXISTS workspace_import_source ON workspace_imports(userId,sourceId,generation)');
    await run(`CREATE TABLE IF NOT EXISTS workspace_import_items (jobId TEXT NOT NULL REFERENCES workspace_imports(id) ON DELETE CASCADE,
      key TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(jobId,key))`);
  }
  async function job(userId, id) {
    const value = await get('SELECT * FROM workspace_imports WHERE id = ? AND userId = ?', [id,userId]);
    if (!value) throw fail('Transfer not found.',404);
    return value;
  }
  const filePath = (jobId, key) => path.join(directory, `${jobId}-${hash(key)}`);
  async function digestFile(filename) {
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
    return digest.digest('hex');
  }
  async function status(userId,id) {
    const value = await job(userId,id);
    const items = await all('SELECT key,kind,digest FROM workspace_import_items WHERE jobId = ?', [id]);
    return { id, state:value.state, result:JSON.parse(value.result || 'null'), items:items.map(row => ({ key:row.key,digest:row.digest,
      offset:row.kind === 'blob' ? (fs.existsSync(filePath(id,row.key)) ? fs.statSync(filePath(id,row.key)).size : 0) : undefined })) };
  }
  function mount(app, requireAuth, asyncRoute) {
    const route = fn => asyncRoute(async (req,res) => { try { await fn(req,res); } catch (error) { if (error.status) return res.status(error.status).json({error:error.message}); throw error; } });
    app.get('/api/workspace-import/capabilities',requireAuth,route(async (_req,res) => res.json({version:1,syncProtocol:2,chunkBytes:262144})));
    app.post('/api/workspace-import',requireAuth,route(async (req,res) => {
      const { sourceId,generation } = req.body || {};
      if (![sourceId,generation].every(value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value))) throw fail('Invalid source workspace.');
      const id = await transaction(async () => {
      const existing = await get("SELECT * FROM workspace_imports WHERE userId = ? AND sourceId = ? AND generation = ? ORDER BY createdAt DESC LIMIT 1", [req.user.id,sourceId,generation]);
      const id = existing?.id || crypto.randomUUID();
      if (!existing) await run('INSERT INTO workspace_imports(id,userId,sourceId,generation,createdAt) VALUES(?,?,?,?,?)', [id,req.user.id,sourceId,generation,new Date().toISOString()]);
      return id;
      });
      res.json(await status(req.user.id,id));
    }));
    app.get('/api/workspace-import/:id',requireAuth,route(async (req,res) => res.json(await status(req.user.id,req.params.id))));
    app.put('/api/workspace-import/:id/items',requireAuth,route(async (req,res) => {
      await transaction(async () => {
        const value = await job(req.user.id,req.params.id);
        if (value.state !== 'uploading') throw fail('This transfer is sealed.',409);
        const { key,kind,digest,payload,offset,base64 } = req.body || {};
        if (typeof key !== 'string' || key.length > 2048 || !/^[a-f0-9]{64}$/.test(digest || '') || !['record','blob'].includes(kind)) throw fail('Invalid transfer item.');
        if (kind === 'record') {
          if (!payload || !['note','reminder','attachment','label','binder','savedPlace','preferences'].includes(payload.type) || typeof payload.value?.syncId !== 'string' || !payload.value.syncId || payload.value.syncId.length > 160 || (payload.type !== 'preferences' && (!Number.isSafeInteger(payload.value.id) || payload.value.id <= 0))) throw fail('Invalid transfer record.');
          if (hash(JSON.stringify(payload)) !== digest) throw fail('Record checksum failed.');
          await run('INSERT OR REPLACE INTO workspace_import_items(jobId,key,kind,digest,payload) VALUES(?,?,?,?,?)', [value.id,key,kind,digest,JSON.stringify(payload)]);
          return res.json({saved:true});
        }
        if (!payload || !Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > 25*1024*1024 || !Number.isSafeInteger(offset) || offset < 0 || typeof base64 !== 'string' || base64.length > 349528 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw fail('Invalid file chunk.');
        const chunk = Buffer.from(base64,'base64');
        if (chunk.length > 262144 || offset + chunk.length > payload.size) throw fail('File chunk exceeds its declared size.');
        const previous = await get('SELECT * FROM workspace_import_items WHERE jobId = ? AND key = ?', [value.id,key]);
        const filename=filePath(value.id,key);
        if (previous && previous.digest !== digest && offset !== 0) throw fail('File changed; restart its upload.',409);
        if (!previous || previous.digest !== digest) {
          fs.writeFileSync(filename,Buffer.alloc(0));
          await run('INSERT OR REPLACE INTO workspace_import_items(jobId,key,kind,digest,payload) VALUES(?,?,?,?,?)', [value.id,key,kind,digest,JSON.stringify(payload)]);
        }
        const size=fs.statSync(filename).size;
        if (offset < size) {
          const handle=fs.openSync(filename,'r'); const bytes=Buffer.alloc(chunk.length);
          try { fs.readSync(handle,bytes,0,chunk.length,offset); } finally { fs.closeSync(handle); }
          if (!bytes.equals(chunk)) throw fail('A retried file chunk differs from the saved chunk.',409);
        } else if (offset === size) fs.appendFileSync(filename,chunk);
        else throw fail('Resume the file at its saved offset.',409);
        const actual=fs.statSync(filename).size;
        if (actual === payload.size && await digestFile(filename) !== digest) throw fail('File checksum failed.');
        res.json({offset:actual});
      });
    }));
    app.post('/api/workspace-import/:id/finalize',requireAuth,route(async (req,res) => {
      const result = await transaction(async () => {
        const value=await job(req.user.id,req.params.id);
        if (value.state === 'complete') return JSON.parse(value.result);
        const manifest=req.body?.items;
        if (!Array.isArray(manifest) || manifest.length > 200000 || new Set(manifest.map(item=>item.key)).size !== manifest.length) throw fail('Invalid transfer manifest.');
        const rows=[];
        for (const item of manifest) {
          const row=await get('SELECT * FROM workspace_import_items WHERE jobId = ? AND key = ?', [value.id,item.key]);
          if (!row || row.digest !== item.digest) throw fail('Transfer is incomplete.',409);
          row.data=JSON.parse(row.payload);
          if (row.kind === 'blob' && (!fs.existsSync(filePath(value.id,row.key)) || fs.statSync(filePath(value.id,row.key)).size !== row.data.size || await digestFile(filePath(value.id,row.key)) !== row.digest)) throw fail('A file has not finished uploading.',409);
          if (row.kind === 'record') rows.push({key:row.key,kind:row.kind,type:row.data.type});
          else rows.push(row);
        }
        // Fresh server identities per import, deterministic across transaction retries.
        const identity=(type,id) => `${type}-import-${hash(`${value.id}:${type}:${id}`)}`;
        const records=rows.filter(row=>row.kind === 'record');
        const mappings={notes:{},reminders:{},attachments:{},labels:{},binders:{},savedPlaces:{}};
        const media=new Map();
        for (const row of rows.filter(row=>row.kind === 'blob')) {
          const isImage=row.data.blobKey?.startsWith('media:');
          const mime=String(row.data.mimeType || '');
          const ext=isImage ? d.safeImageTypes.get(mime) : d.safeAttachmentExtension({originalname:row.data.name || 'attachment',mimetype:mime});
          if (!ext || (isImage && row.data.size > 10*1024*1024)) throw fail('Unsupported media file in transfer.');
          const filename=`import-${hash(`${value.id}:${row.key}`)}${ext}`;
          const destination=path.join(isImage ? d.uploadDir : d.attachmentDir,filename);
          fs.copyFileSync(filePath(value.id,row.key),destination);
          media.set(row.data.blobKey,{filename,mime,size:row.data.size,url:`/api/uploads/images/${filename}`});
          if (isImage) await run(`INSERT INTO note_images(noteId,ownerUserId,storedFilename,originalName,fileSize,mimeType,uploadedAt)
            VALUES(NULL,?,?,?,?,?,?)`,[req.user.id,filename,row.data.name || filename,row.data.size,mime,new Date().toISOString()]);
        }
        const order={label:0,binder:1,savedPlace:2,note:3,reminder:4,attachment:5,preferences:6};
        for (const descriptor of records.sort((a,b)=>order[a.type]-order[b.type])) {
          const record=JSON.parse((await get('SELECT payload FROM workspace_import_items WHERE jobId = ? AND key = ?', [value.id,descriptor.key])).payload);
          const type=record.type;
          const payload=record.value;
          const localId=payload.id;
          const oldSyncId=payload.syncId;
          const syncId=identity(type,oldSyncId);
          delete payload.id; delete payload.userId; delete payload.ownerUserId; delete payload.collaborators;
          payload.syncId=syncId;
          if (type === 'note') {
            for (const [key,item] of media) if (key.startsWith('media:')) {
              const source=key.slice(6);
              payload.noteBody=String(payload.noteBody || '').split(source).join(item.url);
              payload.images=(payload.images || []).map(image=>({...image,dataUrl:image.dataUrl === source ? item.url : image.dataUrl}));
            }
            payload.labels=(payload.labels || []).map(label=>({...label,id:mappings.labels[label.id]?.id,syncId:mappings.labels[label.id]?.syncId}));
          }
          if (type === 'reminder' || type === 'attachment') {
            const note=mappings.notes[payload.noteId];
            if (!note) throw fail('A transfer record refers to a missing note.');
            payload.noteId=note.id; payload.noteSyncId=note.syncId;
          }
          let applied;
          if (type === 'attachment') {
            const file=media.get(`attachment:${oldSyncId}`);
            if (!file) throw fail('An attachment file is missing.');
            const now=new Date().toISOString();const stamp=d.serverLwwStamp();
            const inserted=await run(`INSERT INTO note_attachments(noteId,syncId,originalName,storedFilename,fileSize,mimeType,uploadedAt,lwwPhysicalMs,lwwLogical,lwwDeviceId,lwwOperationId)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[payload.noteId,syncId,d.safeDownloadName(payload.originalName),file.filename,file.size,file.mime,now,stamp.physicalMs,stamp.logical,stamp.deviceId,stamp.operationId]);
            const attachment=await get('SELECT * FROM note_attachments WHERE id = ?', [inserted.id]);
            await d.recordAttachmentSyncChange(attachment,'upsert');
            applied={ok:true,id:inserted.id};
          } else if (type === 'preferences') {
            if (req.body.copyPreferences !== true) continue;
            const mutation={type:'preferences.patch',protocolVersion:2,syncId:'account-preferences',payload,operationId:identity('operation',oldSyncId),lww:d.serverLwwStamp()};
            applied=await d.workspaceSync.apply(req.user.id,mutation,()=>({ok:false}));
          } else {
            const mutation={type:`${type}.upsert`,protocolVersion:2,syncId,payload,operationId:identity('operation',oldSyncId),lww:d.serverLwwStamp()};
            applied=await d.workspaceSync.apply(req.user.id,mutation,()=>type === 'note' ? d.applyNote(req.user.id,mutation) : d.applyReminder(req.user.id,mutation));
          }
          if (!applied.ok) throw fail(applied.error || 'The server rejected an imported item.',409);
          const group={note:'notes',reminder:'reminders',attachment:'attachments',label:'labels',binder:'binders',savedPlace:'savedPlaces'}[type];
          if (group) mappings[group][localId]={id:applied.id,syncId};
        }
        const result={verified:true,sourceId:value.sourceId,generation:value.generation,mappings};
        await run("UPDATE workspace_imports SET state = 'complete',manifest = ?,result = ? WHERE id = ?", [JSON.stringify(manifest),JSON.stringify(result),value.id]);
        d.afterDatabaseCommit(() => { for (const row of rows.filter(row=>row.kind === 'blob')) {try{fs.unlinkSync(filePath(value.id,row.key));}catch{}} });
        return result;
      });
      res.json(result);
    }));
    app.delete('/api/workspace-import/:id',requireAuth,route(async (req,res) => {
      const value=await job(req.user.id,req.params.id);
      await transaction(async()=>{
        await run('DELETE FROM workspace_import_items WHERE jobId = ?', [value.id]);
        await run('DELETE FROM workspace_imports WHERE id = ? AND userId = ?', [value.id,req.user.id]);
      });
      for (const name of fs.readdirSync(directory)) if (name.startsWith(`${value.id}-`)) fs.unlinkSync(path.join(directory,name));
      res.status(204).end();
    }));
  }
  async function removeForUser(userId) {
    const jobs = await all('SELECT id FROM workspace_imports WHERE userId = ?', [userId]);
    d.afterDatabaseCommit(() => {
      for (const job of jobs) for (const name of fs.readdirSync(directory)) if (name.startsWith(`${job.id}-`)) {try {fs.unlinkSync(path.join(directory,name));} catch {}}
    });
  }
  return {init,mount,removeForUser};
}
module.exports={createWorkspaceImport};
