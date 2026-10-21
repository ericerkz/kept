const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {canonicalJson}=require('../shared/canonical-json');
const {startFixture}=require('../test-support/session-fixture.cjs');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])])):value;

test('canonical record checksums ignore object key order and preserve array order and JSON values',()=>{
 const value={z:undefined,b:{'10':10,'2':2,z:null,a:'🍲 é\n'},a:[false,0,-0,1.5,undefined],date:new Date('2026-01-01T00:00:00Z')};
 const serialized=JSON.parse(JSON.stringify(value));
 assert.equal(canonicalJson(value),canonicalJson(reorder(serialized)));
 assert.notEqual(canonicalJson([1,2]),canonicalJson([2,1]));
 assert.notEqual(canonicalJson({name:'Original'}),canonicalJson({name:'Changed'}));
 assert.deepEqual(JSON.parse(canonicalJson(value)),serialized);
});

test('actual migration client uploads through reordered native JSON, resumes, and rejects changed content',async()=>{
 const fixture=await startFixture();let token;
 async function api(path,data,method=data?'POST':'GET',expected=200){
  const response=await fetch(fixture.origin+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});
  assert.equal(response.status,expected,await response.clone().text());return response.json();
 }
 try {
  const credentials={username:'owner',displayName:'Owner',password:'test-password-123'};
  await api('/setup/admin',credentials,'POST',201);token=(await api('/auth/login',credentials)).token;
  assert.equal((await api('/workspace-import/capabilities')).recordChecksum,'canonical-json-v1');
  const job=await api('/workspace-import',{sourceId:'device',generation:'first'});
  const puts=[];
  const exports={};
  const source=ts.transpileModule(fs.readFileSync('src/app/services/workspace-migration.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
  vm.runInNewContext(source,{exports,console,URL,TextEncoder,Promise,Error,Uint8Array,require(name){
   if(name==='@angular/core')return{Injectable:()=>target=>target};
   if(name==='@capacitor/core')return{Capacitor:{isNativePlatform:()=>true},CapacitorHttp:{request:async request=>{
    const transformed=request.data===undefined?undefined:reorder(JSON.parse(JSON.stringify(request.data)));
    if(request.method==='PUT')puts.push(transformed);
    const response=await fetch(request.url,{method:request.method,headers:request.headers,body:transformed===undefined?undefined:JSON.stringify(transformed)});
    return{status:response.status,data:await response.json()};
   }}};
   if(name==='rxjs')return require('rxjs');
   if(name.startsWith('@noble/hashes/'))return require(name);
   if(name.endsWith('/canonical-json'))return{canonicalJson};
   if(name.endsWith('/workspace'))return{RESOURCE_STORES:{note:'notes',preferences:'preferences'}};
   if(name.endsWith('/attachments'))return{};
   throw Error(`Unexpected migration dependency: ${name}`);
  }});
  const note={id:1,syncId:'device-note',noteTitle:'iOS 🍲',noteBody:'Same content after serialization',checkBoxes:[{id:42,data:'Keep this row',done:false}],pinned:false,bgColor:'',labels:[],images:[],optional:undefined};
  const row={key:'snapshot|notes|device-note',store:'notes',record:{syncId:note.syncId,value:note}};
  const client=new exports.WorkspaceMigrationService({}, {snapshotPage:async(_id,after)=>after?[]:[row]},{});
  const connection={connectionId:'prepared',url:fixture.origin,accountId:1,token};
  const snapshot={id:'snapshot',preferences:{theme:'light',followSystemTheme:true,showPastReminders:false}};
  const manifest=await client.uploadSnapshot(connection,job.id,snapshot);
  assert.equal(puts.length,2);assert.ok(puts.every(item=>item.digestFormat==='canonical-json-v1'));
  assert.equal(manifest.length,2);
  await client.uploadSnapshot(connection,job.id,snapshot);assert.equal(puts.length,2,'resuming does not resend matching records');
  const item=puts.find(item=>item.payload.type==='note');
  await api(`/workspace-import/${job.id}/items`,{...item,payload:{...item.payload,value:{...item.payload.value,noteBody:'Changed'}}},'PUT',400);
  await api(`/workspace-import/${job.id}/items`,{...item,digestFormat:'unknown'},'PUT',400);
  // Existing Android/web clients using raw JSON checksums remain supported.
  const legacy={type:'binder',value:{id:2,syncId:'legacy',name:'Legacy checksum'}};
  await api(`/workspace-import/${job.id}/items`,{key:'record:binder:legacy',kind:'record',payload:legacy,digest:digest(JSON.stringify(legacy))},'PUT');
  const result=await api(`/workspace-import/${job.id}/finalize`,{items:manifest});assert.equal(result.verified,true);
  const imported=await api(`/notes/${result.mappings.notes[1].id}`);
  assert.equal(imported.noteTitle,note.noteTitle);assert.equal(imported.noteBody,note.noteBody);assert.equal(imported.checkBoxes[0].id,42);
 } finally {await fixture.close();}
});
