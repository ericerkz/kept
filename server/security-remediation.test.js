const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { startFixture } = require('../test-support/session-fixture.cjs');

async function setup(t, env = {}) {
  const f = await startFixture({env}); t.after(() => f.close());
  const password = 'isolated-remediation-password';
  async function api(endpoint, {token,body,method=body?'POST':'GET',form}={}) {
    const response = await fetch(f.origin+endpoint, {method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},body:form || (body?JSON.stringify(body):undefined)});
    const data = response.status === 204 ? null : await response.json();
    return {status:response.status,data};
  }
  assert.equal((await api('/api/setup/admin',{body:{username:'owner',password}})).status,201);
  const owner=(await api('/api/auth/login',{body:{username:'owner',password}})).data;
  const recipient=(await api('/api/users',{token:owner.token,body:{username:'recipient',password,role:'user'}})).data;
  const other=(await api('/api/auth/login',{body:{username:'recipient',password}})).data;
  return {f,api,owner,recipient,other,env};
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('failed Takeout import cannot roll back a different user\'s acknowledged save', {timeout:20000}, async t => {
  const {f,api,owner,other}=await setup(t);
  const zip=new AdmZip();
  for(let i=0;i<400;i++)zip.addFile(`Takeout/Keep/a-${String(i).padStart(4,'0')}.json`,Buffer.from(JSON.stringify({title:`Rollback fixture ${i}`,textContent:'test'})));
  zip.addFile('Takeout/Keep/z-bomb.json',Buffer.from('{}'));
  const bytes=zip.toBuffer();let offset=0;
  while((offset=bytes.indexOf(Buffer.from('PK\x01\x02','binary'),offset))!==-1){
    const length=bytes.readUInt16LE(offset+28);
    if(bytes.subarray(offset+46,offset+46+length).toString().endsWith('z-bomb.json')){bytes.writeUInt32LE(300*1024*1024,offset+24);break;}offset+=4;
  }
  const form=new FormData();form.append('takeout',new Blob([bytes],{type:'application/zip'}),'fixture.zip');
  let finished=false;
  const importing=api('/api/import/google-takeout',{token:owner.token,method:'POST',form}).finally(()=>{finished=true;});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(finished,false,'send a second request while the import is running');
  const saved=await api('/api/notes',{token:other.token,body:{noteTitle:'Must remain saved',noteBody:'Other account'}});
  assert.equal(saved.status,201);assert.equal((await importing).status,400);
  assert.equal((await f.sql('SELECT id FROM notes WHERE noteTitle = ?',['Must remain saved'])).length,1);
  assert.equal((await f.sql("SELECT id FROM notes WHERE noteTitle LIKE 'Rollback fixture %'")).length,0);
});

test('Smart Capture sanitizes writes and historical malformed shared notes remain readable/syncable', async t => {
  const {f,api,owner,recipient,other}=await setup(t);
  const malformed='<iframe>'.repeat(2200);
  const created=await api('/api/ai/action-plan/execute',{token:owner.token,body:{transcript:'test',actionPlan:{actions:[{type:'create_text_note',title:'Malformed fixture',text:malformed}]},executeOptions:{confirmed:true}}});
  assert.equal(created.status,200,JSON.stringify(created.data));
  const id=created.data.createdNoteIds[0];
  assert.equal((await api(`/api/notes/${id}/collaborators`,{token:owner.token,method:'PUT',body:{userIds:[recipient.id]}})).status,200);
  await f.sql('UPDATE notes SET noteBody = ? WHERE id = ?',[malformed,id]);
  for(const token of [owner.token,other.token]){
    const notes=await api('/api/notes',{token});assert.equal(notes.status,200);
    assert.doesNotMatch(notes.data.find(note=>note.id===id).noteBody,/<iframe/i);
    assert.equal((await api('/api/sync/bootstrap?protocolVersion=2',{token})).status,200);
  }
});

test('owner revocation cancels rejoin; voluntary Undo is single-use and expires', async t => {
  const {f,api,owner,recipient,other}=await setup(t);
  const note=(await api('/api/notes',{token:owner.token,body:{noteTitle:'Shared'}})).data;
  const share=ids=>api(`/api/notes/${note.id}/collaborators`,{token:owner.token,method:'PUT',body:{userIds:ids}});
  const rejoin=()=>api(`/api/notes/${note.id}/collaborators/rejoin`,{token:other.token,body:{}});
  await share([recipient.id]);await share([]);
  assert.equal((await rejoin()).status,403);
  assert.equal((await api(`/api/notes/${note.id}`,{token:other.token})).status,404);
  await share([recipient.id]);
  assert.equal((await api(`/api/notes/${note.id}`,{token:other.token,method:'DELETE'})).status,204);
  const results=await Promise.all([rejoin(),rejoin()]);assert.deepEqual(results.map(r=>r.status).sort(),[204,403]);
  await api(`/api/notes/${note.id}`,{token:other.token,method:'DELETE'});
  await share([]);assert.equal((await rejoin()).status,403,'owner removal cancels a prior self-removal grant too');
  await share([recipient.id]);await api(`/api/notes/${note.id}`,{token:other.token,method:'DELETE'});
  await f.sql('UPDATE note_collaborator_rejoin_grants SET grantedAt = ?',[new Date(Date.now()-6*60000).toISOString()]);
  assert.equal((await rejoin()).status,403);
  await f.sql("DELETE FROM app_settings WHERE key = 'rejoinGrantsOwnerRevocationFixed'");
  await f.restart();assert.equal((await f.sql('SELECT * FROM note_collaborator_rejoin_grants')).length,0,'unsafe legacy grants are invalidated on upgrade');
});

async function limitTo(h, extra) {
  const usage=(await h.api('/api/settings/storage',{token:h.owner.token})).data.usedBytes;
  h.env.KEPT_STORAGE_QUOTA_BYTES=String(usage+extra);await h.f.restart();
  return Number(h.env.KEPT_STORAGE_QUOTA_BYTES);
}

test('REST and both sync protocols reject over-quota note growth atomically; smaller edits still work', async t => {
  const h=await setup(t,{KEPT_STORAGE_QUOTA_BYTES:String(8*1024*1024)});
  const {api,owner,other,f}=h;
  const limit=await limitTo(h,256*1024);
  const rejected=await api('/api/notes',{token:other.token,body:{noteTitle:'Too large',noteBody:'x'.repeat(512*1024)}});
  assert.equal(rejected.status,507);assert.equal(rejected.data.code,'STORAGE_QUOTA_EXCEEDED');
  assert.equal((await f.sql("SELECT id FROM notes WHERE noteTitle = 'Too large'")).length,0);
  for(const version of [1,2]){
    const operationId=crypto.randomUUID(),syncId=`review-large-${version}`;
    const sync=await api('/api/sync/mutations',{token:other.token,body:{protocolVersion:version,mutations:[{type:'note.upsert',operationId,syncId,payload:{noteTitle:'Too large',noteBody:'x'.repeat(512*1024)},lww:{physicalMs:Date.now(),logical:0,deviceId:'test',operationId}}]}});
    assert.equal(sync.status,200);assert.equal(sync.data.results[0].status,507);
    assert.equal((await f.sql('SELECT id FROM notes WHERE syncId = ?',[syncId])).length,0);
  }
  const small=await api('/api/notes',{token:other.token,body:{noteTitle:'Small save',noteBody:'Still works'}});
  assert.equal(small.status,201);
  assert.equal((await api(`/api/notes/${small.data.id}`,{token:other.token,method:'DELETE'})).status,204);
  assert.ok((await api('/api/settings/storage',{token:owner.token})).data.usedBytes<=limit);
});

test('concurrent image uploads reserve bytes before writing and failed uploads leave no orphan files', async t => {
  const h=await setup(t,{KEPT_STORAGE_QUOTA_BYTES:String(8*1024*1024)}),{api,owner,f}=h;
  const limit=await limitTo(h,300*1024);
  const upload=()=>{const form=new FormData();form.append('image',new Blob([Buffer.alloc(200*1024)],{type:'image/png'}),'photo.png');return api('/api/uploads/images',{token:owner.token,method:'POST',form});};
  const results=await Promise.all([upload(),upload()]);assert.deepEqual(results.map(r=>r.status).sort(),[201,507]);
  assert.equal((await fs.readdir(path.join(f.directory,'uploads'))).length,1);
  assert.ok((await api('/api/settings/storage',{token:owner.token})).data.usedBytes<=limit);
  const note=(await api('/api/notes',{token:owner.token,body:{noteTitle:'Image',images:[{id:'p',dataUrl:results.find(r=>r.status===201).data.url}]}})).data;
  assert.equal((await api(`/api/notes/${note.id}`,{token:owner.token,method:'DELETE'})).status,204);
  assert.equal((await fs.readdir(path.join(f.directory,'uploads'))).length,0);
  assert.equal((await upload()).status,201,'deleting media releases quota immediately after commit');
});

test('workspace import staging is charged; finalization rollback restores staged media for retry', async t => {
  const h=await setup(t,{KEPT_STORAGE_QUOTA_BYTES:String(8*1024*1024)}),{api,owner,f}=h;
  const job=(await api('/api/workspace-import',{token:owner.token,body:{sourceId:'local-review',generation:'generation-review'}})).data;
  const bytes=Buffer.alloc(64*1024,65),source='/__kept_local_media/photo';
  const blob={key:'image',kind:'blob',digest:hash(bytes),payload:{size:bytes.length,mimeType:'image/png',blobKey:'media:'+source,name:'photo.png'},offset:0,base64:bytes.toString('base64')};
  const bad=await api(`/api/workspace-import/${job.id}/items`,{token:owner.token,method:'PUT',body:{...blob,digest:'a'.repeat(64)}});
  assert.equal(bad.status,400);assert.equal((await fs.readdir(path.join(f.directory,'imports','workspaces'))).length,0);
  await fs.writeFile(path.join(f.directory,'imports','workspaces',`${job.id}-${hash('image')}`),Buffer.from('interrupted upload'));
  await f.restart();
  assert.equal((await api(`/api/workspace-import/${job.id}/items`,{token:owner.token,method:'PUT',body:blob})).status,200);
  const payload={type:'note',value:{id:1,syncId:'local-note',noteTitle:'Imported image',noteBody:'x'.repeat(100000),images:[{id:'p',dataUrl:source}]}};
  const record={key:'note',kind:'record',digest:hash(JSON.stringify(payload)),payload};
  assert.equal((await api(`/api/workspace-import/${job.id}/items`,{token:owner.token,method:'PUT',body:record})).status,200);
  const stagedName=(await fs.readdir(path.join(f.directory,'imports','workspaces')))[0];
  const stagedPath=path.join(f.directory,'imports','workspaces',stagedName);
  await fs.rename(stagedPath,stagedPath+'.rollback-'+blob.digest+'-'+crypto.randomUUID());
  await fs.writeFile(stagedPath,Buffer.alloc(10,66));
  await f.restart();
  assert.deepEqual(await fs.readFile(stagedPath),bytes,'restart restores a file replacement interrupted before commit');
  const destination=`import-${hash(`${job.id}:image`)}.png`;
  await fs.rename(path.join(f.directory,'imports','workspaces',stagedName),path.join(f.directory,'uploads',destination));
  await f.restart();
  assert.equal((await fs.readdir(path.join(f.directory,'uploads'))).length,0,'restart recovers a move interrupted before the SQLite commit');
  assert.equal((await fs.stat(path.join(f.directory,'imports','workspaces',stagedName))).size,bytes.length);
  await limitTo(h,4096);
  const manifest={items:[{key:'image',digest:blob.digest},{key:'note',digest:record.digest}]};
  const rejected=await api(`/api/workspace-import/${job.id}/finalize`,{token:owner.token,body:manifest});
  assert.equal(rejected.status,507,JSON.stringify(rejected.data));
  assert.equal((await fs.readdir(path.join(f.directory,'uploads'))).length,0);
  const status=await api(`/api/workspace-import/${job.id}`,{token:owner.token});assert.equal(status.data.state,'uploading');
  assert.equal(status.data.items.find(item=>item.kind==='blob'||item.key==='image').offset,bytes.length);
  const extra=await api(`/api/workspace-import/${job.id}/items`,{token:owner.token,method:'PUT',body:{...blob,key:'too-much',digest:hash(bytes)}});
  assert.equal(extra.status,507,'staging is bounded even before finalization');
  assert.equal((await fs.readdir(path.join(f.directory,'imports','workspaces'))).length,1);
  h.env.KEPT_STORAGE_QUOTA_BYTES=String(8*1024*1024);await f.restart();
  const finalized=await api(`/api/workspace-import/${job.id}/finalize`,{token:owner.token,body:manifest});assert.equal(finalized.status,200,JSON.stringify(finalized.data));
  assert.equal((await api(`/api/workspace-import/${job.id}/finalize`,{token:owner.token,body:manifest})).status,200,'completed transfers stay idempotent');
  assert.equal((await fs.readdir(path.join(f.directory,'imports','workspaces'))).length,0);
  assert.equal((await fs.readdir(path.join(f.directory,'uploads'))).length,1);
});

test('quota-managed sync retains latest states/tombstones and replay identities without duplicating old note bodies', async t => {
  const {f,api,owner}=await setup(t,{KEPT_STORAGE_QUOTA_BYTES:String(8*1024*1024)});
  const mutations=[];
  for(let i=0;i<12;i++){
    const operationId=crypto.randomUUID();
    const mutation={type:'note.upsert',syncId:'compacted-note',operationId,lww:{physicalMs:Date.now()+i,logical:0,deviceId:'test',operationId},payload:{noteTitle:'Compacted',noteBody:`version ${i} `+'x'.repeat(100000)}};
    mutations.push(mutation);
    const result=await api('/api/sync/mutations',{token:owner.token,body:{protocolVersion:2,mutations:[mutation]}});
    assert.equal(result.data.results[0].ok,true,JSON.stringify(result.data.results[0]));
  }
  assert.equal((await f.sql("SELECT COUNT(*) AS n FROM sync_changes WHERE resourceSyncId = 'compacted-note'"))[0].n,1);
  const receipts=await f.sql('SELECT result FROM workspace_operations');
  assert.equal(receipts.length,12);assert.ok(receipts.every(row=>row.result.length<1000));
  const replay=await api('/api/sync/mutations',{token:owner.token,body:{protocolVersion:2,mutations:[mutations[0]]}});
  assert.equal(replay.data.results[0].canonical.noteBody,mutations[11].payload.noteBody);
  const before=(await api('/api/settings/storage',{token:owner.token})).data.usedBytes;
  const note=(await api('/api/notes',{token:owner.token})).data.find(n=>n.syncId==='compacted-note');
  assert.equal((await api(`/api/notes/${note.id}`,{token:owner.token,method:'DELETE'})).status,204);
  for(const version of [1,2]){
    const changes=await api(`/api/sync/changes?cursor=0&protocolVersion=${version}`,{token:owner.token});
    assert.equal(changes.status,200);
    const entry=changes.data.changes.find(c=>c.resourceSyncId==='compacted-note');assert.equal(entry.operation,'delete');
  }
  const replayDeleted=await api('/api/sync/mutations',{token:owner.token,body:{protocolVersion:2,mutations:[mutations[0]]}});
  assert.equal(replayDeleted.data.results[0].canonical,null);
  assert.equal((await f.sql("SELECT id FROM notes WHERE syncId='compacted-note'")).length,0);
  assert.ok((await api('/api/settings/storage',{token:owner.token})).data.usedBytes<before,'deletion releases occupied database pages');
});

test('abandoned imports are expired and quota-managed manual backup retention is bounded', async t => {
  const {f,api,owner}=await setup(t,{KEPT_STORAGE_QUOTA_BYTES:String(8*1024*1024)});
  const job=(await api('/api/workspace-import',{token:owner.token,body:{sourceId:'abandoned',generation:'old'}})).data;
  const bytes=Buffer.alloc(100);
  await api(`/api/workspace-import/${job.id}/items`,{token:owner.token,method:'PUT',body:{key:'image',kind:'blob',digest:hash(bytes),payload:{size:100,mimeType:'image/png',blobKey:'media:old',name:'old.png'},offset:0,base64:bytes.toString('base64')}});
  await f.sql('UPDATE workspace_imports SET updatedAt = ? WHERE id = ?',[new Date(Date.now()-8*86400000).toISOString(),job.id]);
  await f.restart();
  assert.equal((await api(`/api/workspace-import/${job.id}`,{token:owner.token})).status,404);
  assert.equal((await fs.readdir(path.join(f.directory,'imports','workspaces'))).length,0);
  for(let i=0;i<2;i++)assert.equal((await api('/api/admin/backup/full',{token:owner.token,body:{}})).status,200);
  assert.equal((await fs.readdir(path.join(f.directory,'backups'))).filter(n=>n.endsWith('-full.zip')).length,1);
});

test('existing full receipts survive enabling quotas and still replay without repeating a write', async t => {
  const h=await setup(t),{api,owner,f}=h;
  const operationId=crypto.randomUUID();
  const mutation={type:'note.upsert',syncId:'legacy-receipt-note',operationId,lww:{physicalMs:Date.now(),logical:0,deviceId:'test',operationId},payload:{noteTitle:'Existing receipt',noteBody:'x'.repeat(100000)}};
  const original=await api('/api/sync/mutations',{token:owner.token,body:{protocolVersion:2,mutations:[mutation]}});
  assert.equal(original.data.results[0].ok,true);
  assert.ok((await f.sql('SELECT result FROM workspace_operations'))[0].result.length>100000);
  h.env.KEPT_STORAGE_QUOTA_BYTES=String(8*1024*1024);await f.restart();
  assert.ok((await f.sql('SELECT result FROM workspace_operations'))[0].result.length<1000);
  const replay=await api('/api/sync/mutations',{token:owner.token,body:{protocolVersion:2,mutations:[mutation]}});
  assert.equal(replay.data.results[0].canonical.noteBody,mutation.payload.noteBody);
  assert.equal(replay.data.results[0].payload.noteBody,mutation.payload.noteBody);
  assert.equal((await f.sql('SELECT id FROM notes')).length,1);
  h.env.KEPT_STORAGE_QUOTA_BYTES='';await f.restart();
  const withoutQuota=await api('/api/sync/mutations',{token:owner.token,body:{protocolVersion:2,mutations:[mutation]}});
  assert.equal(withoutQuota.data.results[0].canonical.noteBody,mutation.payload.noteBody);
  assert.equal(withoutQuota.data.results[0].payload.noteBody,mutation.payload.noteBody);
});

test('anonymous OAuth state consumes quota while sign-in still has bounded recovery space', async t => {
  const h=await setup(t,{KEPT_STORAGE_QUOTA_BYTES:String(8*1024*1024)}),{api,owner,f}=h;
  const client=(await api('/oauth/register',{body:{client_name:'Quota fixture',redirect_uris:['http://localhost:9876/callback']}})).data;
  const limit=await limitTo(h,40*1024);
  let rejected=false;
  for(let i=0;i<50;i++){
    const params=new URLSearchParams({client_id:client.client_id,redirect_uri:'http://localhost:9876/callback',response_type:'code',code_challenge:'a'.repeat(43),code_challenge_method:'S256',state:'x'.repeat(3000)});
    const response=await fetch(f.origin+'/oauth/authorize?'+params);await response.text();
    if(response.status===507){rejected=true;break;}
    assert.equal(response.status,200);
  }
  assert.equal(rejected,true,'public authorization requests must not bypass the allocation');
  const login=await api('/api/auth/login',{body:{username:'owner',password:'isolated-remediation-password'}});
  assert.equal(login.status,200,'the owner can still sign in to free storage');
  assert.ok((await api('/api/settings/storage',{token:owner.token})).data.usedBytes<=limit+1024*1024);
});
