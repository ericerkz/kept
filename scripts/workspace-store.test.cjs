const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createStore}=require('../test-support/workspace-store.cjs');
const {IDBFactory}=require('fake-indexeddb');
const local=()=>({id:'device',partition:'local:device',mode:'local',generation:'first',status:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),preferences:{theme:'light',followSystemTheme:true,showPastReminders:false},nextId:1,revision:0});

test('large-library incremental sync touches only affected notes; empty polls do not rewrite notes or native revisions', async t => {
  const {IDBObjectStore,IDBIndex}=require('fake-indexeddb');
  const store=createStore(),workspace=await store.ensureServerWorkspace('large-library');
  t.after(async()=>{(await store.open()).close();});
  const notes=Array.from({length:2138},(_,i)=>({id:i+1,syncId:`note-${i}`,noteTitle:`Note ${i}`,archived:i>100,labels:[],attachments:[]}));
  await store.reconcile(workspace,{snapshot:{note:notes},cursor:10});
  const revision=(await store.getWorkspace(workspace.id)).revision;
  const put=IDBObjectStore.prototype.put,getAll=IDBIndex.prototype.getAll;
  let writes=0,libraryReads=0;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='notes')writes++;return put.apply(this,args);};
  IDBIndex.prototype.getAll=function(...args){if(this.objectStore.name==='notes')libraryReads++;return getAll.apply(this,args);};
  t.after(()=>{IDBObjectStore.prototype.put=put;IDBIndex.prototype.getAll=getAll;});
  assert.equal(await store.reconcile(workspace,{changes:[],cursor:10,serverTime:Date.now()}),false);
  assert.equal(writes,0);assert.equal(libraryReads,0);
  assert.equal((await store.getWorkspace(workspace.id)).revision,revision);
  assert.equal(await store.reconcile(workspace,{changes:[{sequence:11,resourceType:'note',resourceSyncId:'note-0',operation:'upsert',payload:{...notes[0],noteTitle:'Edited'}}],cursor:11}),true);
  assert.equal(writes,1);assert.equal(libraryReads,0);
  writes=0;
  await store.reconcile(workspace,{changes:[{sequence:12,resourceType:'reminder',resourceSyncId:'reminder',operation:'upsert',payload:{id:1,syncId:'reminder',noteId:1}}],cursor:12});
  assert.equal(writes,0);assert.equal(libraryReads,0);
});

test('attachment deltas refresh both old and new parent notes, including deletion',async()=>{
  const store=createStore(),workspace=await store.ensureServerWorkspace('attachment-deltas');
  await store.reconcile(workspace,{snapshot:{note:[{id:1,syncId:'one',labels:[]},{id:2,syncId:'two',labels:[]}],attachment:[{id:3,syncId:'file',noteId:1,originalName:'old.txt'}]},cursor:1});
  const change=(sequence,payload)=>({sequence,resourceType:'attachment',resourceSyncId:'file',operation:payload?'upsert':'delete',payload});
  await store.reconcile(workspace,{changes:[change(2,{id:3,syncId:'file',noteId:2,originalName:'new.txt'})],cursor:2});
  const notes=await store.listNotes(workspace.partition);
  assert.equal(notes.find(note=>note.id===1).attachments.length,0);
  assert.equal(notes.find(note=>note.id===2).attachments[0].originalName,'new.txt');
  await store.reconcile(workspace,{changes:[change(3,null)],cursor:3});
  assert.ok((await store.listNotes(workspace.partition)).every(note=>note.attachments.length===0));
});

test('v3 cache cleanup removes only redundant source fields and preserves queued replay bytes, baseline and media',async()=>{
  const factory=new IDBFactory();
  const db=await new Promise((resolve,reject)=>{
    const request=factory.open('kept-offline-v1',3);
    request.onupgradeneeded=()=>{
      for(const name of ['notes','baseline','outbox','blobs','syncState']){
        const store=request.result.createObjectStore(name,{keyPath:'key'});store.createIndex('partition','partition');
      }
    };request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const note={id:1,syncId:'imported',noteTitle:'Canonical title',noteBody:'Canonical body',checkBoxes:[{id:4,data:'Keep this',done:true}],pattern:'travel',customExtension:{kept:true},annotations:[{url:'https://example.test'}],title:'Raw title',textContent:'Raw text',listContent:[{text:'Duplicate'}],createdTimestampUsec:1,updatedAt:'2020-01-01T00:00:00Z'};
  const operation={key:'server|op',partition:'server',operationId:'op',syncId:'imported',type:'note.upsert',payload:note,lww:{physicalMs:5,logical:1,deviceId:'device',operationId:'op'},createdAt:5};
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(['notes','baseline','outbox','blobs','syncState'],'readwrite');
    tx.objectStore('notes').put({key:'server|imported',partition:'server',syncId:'imported',value:note});
    tx.objectStore('baseline').put({key:'server|note|imported',partition:'server',resourceType:'note',syncId:'imported',value:note});
    tx.objectStore('outbox').put(operation);
    tx.objectStore('blobs').put({key:'server|media',partition:'server',value:new Blob(['photo'])});
    tx.objectStore('syncState').put({key:'server',partition:'server',cursor:44,serverOffsetMs:0});
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });db.close();
  const store=createStore(factory),[cleaned]=await store.listNotes('server');
  assert.equal(cleaned.title,undefined);assert.equal(cleaned.listContent,undefined);assert.equal(cleaned.textContent,undefined);
  assert.equal(cleaned.noteTitle,note.noteTitle);assert.deepEqual(cleaned.checkBoxes,note.checkBoxes);
  assert.equal(cleaned.pattern,'travel');assert.deepEqual(cleaned.customExtension,note.customExtension);assert.deepEqual(cleaned.annotations,note.annotations);
  assert.equal(JSON.stringify((await store.listOutbox('server'))[0]),JSON.stringify(operation));
  const baseline=await store.request((await store.open()).transaction('baseline').objectStore('baseline').get('server|note|imported'));
  assert.equal(baseline.value.noteBody,note.noteBody);assert.equal(baseline.value.listContent,undefined);
  assert.equal((await store.getSyncState('server')).cursor,44);assert.equal(await(await store.getBlob('server','media')).text(),'photo');
  (await store.open()).close();
});

test('storage-blocked uploads keep their replay identity and blobs across reopening and reconciliation', async()=>{
  const database=new IDBFactory(),store=createStore(database),workspace=await store.ensureServerWorkspace('quota-test');
  const url='/__kept_local_media/photo';
  await store.commitMutation(workspace,'image.upload','image-id',{url,filename:'photo.png'}, {
    blobs:[{key:`media:${url}`,value:new Blob(['preserved image'],{type:'image/png'})}]
  });
  const [entry]=await store.listOutbox(workspace.partition);
  assert.equal(await store.markUploadStorageBlocked(workspace,entry),true);
  const reopened=createStore(database);
  await reopened.reconcile(workspace,{changes:[],cursor:1});
  const [pending]=await reopened.listOutbox(workspace.partition);
  assert.equal(pending.blockedBy,'storage');
  assert.equal(pending.attempts,1);
  assert.equal(pending.operationId,entry.operationId);
  assert.equal(await (await reopened.getBlob(workspace.partition,`media:${url}`)).text(),'preserved image');
  await assert.rejects(reopened.markUploadStorageBlocked({...workspace,generation:'obsolete'},entry),/Obsolete/);
  await reopened.removeOutbox([entry.key]);
  assert.equal(await reopened.markUploadStorageBlocked(workspace,entry),false,'a deleted upload must not be recreated');
  assert.equal((await reopened.listOutbox(workspace.partition)).length,0);
});
test('local identity, native receipt and blobs commit together; failed writes preserve previous data',async()=>{
  const store=createStore(),workspace=local();await store.saveWorkspace(workspace);
  const action={actionId:'native-1',workspaceId:workspace.id,generation:workspace.generation,sequence:1};
  const note=await store.commitMutation(workspace,'note.upsert','stable',{noteTitle:'original'},{action,blobs:[{key:'media:image',value:new Blob(['image'])}]});
  assert.equal(note.id,1);assert.equal((await store.listOutbox(workspace.partition)).length,0);
  assert.equal((await store.commitMutation(workspace,'note.upsert','stable',{noteTitle:'replayed'},{action})).noteTitle,'original');
  assert.equal((await store.getWorkspace(workspace.id)).revision,1);
  assert.equal(await(await store.getBlob(workspace.partition,'media:image')).text(),'image');
  const db=await store.open();const original=db.transaction.bind(db);
  db.transaction=(...args)=>{const tx=original(...args); if(args[1]==='readwrite') queueMicrotask(()=>tx.abort());return tx;};
  await assert.rejects(store.commitMutation(workspace,'note.upsert','stable',{noteTitle:'must abort'},{action:{...action,actionId:'native-2'}}));
  db.transaction=original;
  assert.equal((await store.listNotes(workspace.partition))[0].noteTitle,'original');
  assert.equal(await store.hasReceipt(workspace.partition,'native-2'),false);
  await assert.rejects(store.commitMutation({...workspace,generation:'obsolete'},'note.delete','stable',{}));
  assert.equal((await store.listNotes(workspace.partition)).length,1);
});
test('new notes sort above existing and manually ordered notes without moving edited notes',async()=>{
 const {IDBFactory}=require('fake-indexeddb');const database=new IDBFactory();
 const store=createStore(database),workspace={...local(),demoNotesSeeded:false};await store.saveWorkspace(workspace);
 await store.seedLocalDemoNotes(workspace);
 const pinned=await store.commitMutation(workspace,'note.upsert','pinned',{noteTitle:'Pinned',pinned:true,sortOrder:Date.now()+100});
 const older=await store.commitMutation(workspace,'note.upsert','older',{noteTitle:'Older',pinned:false});
 const newer=await store.commitMutation(workspace,'note.upsert','newer',{noteTitle:'Newer',pinned:false});
 assert.ok(newer.sortOrder>older.sortOrder);
 const demos=(await store.listNotes(workspace.partition)).filter(note=>note.isDemo);
 assert.ok(demos.every(note=>older.sortOrder>note.sortOrder));
 const order=async()=>Array.from(await store.listNotes(workspace.partition)).filter(note=>!note.isDemo).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.sortOrder-a.sortOrder).map(note=>note.syncId);
 assert.deepEqual(await order(),['pinned','newer','older']);
 await store.commitMutation(workspace,'note.upsert','older',{id:older.id,noteTitle:'Edited older note'});
 assert.deepEqual(await order(),['pinned','newer','older'],'editing does not move a note');
 await store.commitMutation(workspace,'note.reorder','note-order',{syncIds:['older','newer']});
 const capture={actionId:'native-capture',workspaceId:workspace.id,generation:workspace.generation,sequence:1,kind:'note.upsert',targetSyncId:'captured',payload:{noteTitle:'Captured'}};
 const captured=await store.commitMutation(workspace,'note.upsert','captured',{noteTitle:'Captured',pinned:false},{action:capture});
 assert.deepEqual(await order(),['pinned','captured','older','newer']);
 assert.equal((await store.getNote(workspace.partition,pinned.id)).pinned,true);
 const saved=await createStore(database).getNote(workspace.partition,captured.id);assert.equal(saved.sortOrder,captured.sortOrder,'sort order survives reopening storage');
});
test('acknowledging a sent edit preserves later edits and maps related IDs; tombstones and aborted pages are atomic',async()=>{
  const store=createStore(),workspace=await store.ensureServerWorkspace('server|1');
  await store.reconcile(workspace,{snapshot:{note:[{id:42,syncId:'note',noteTitle:'server',labels:[{id:5,syncId:'label',name:'Old name',added:true}]}],label:[{id:5,syncId:'label',name:'Current name'}]},cursor:4});
  const appliedLabel=(await store.listNotes(workspace.partition))[0].labels[0];
  assert.equal(appliedLabel.name,'Current name');assert.equal(appliedLabel.added,true,'catalog refreshes preserve the note’s applied Label flag');
  await store.commitMutation(workspace,'note.upsert','note',{noteTitle:'first edit'});
  const [sent]=await store.listOutbox(workspace.partition);
  await store.commitMutation(workspace,'note.upsert','note',{noteTitle:'later edit'});
  await store.commitMutation(workspace,'reminder.upsert','reminder',{noteId:-1,noteSyncId:'note',dueAtUtc:'2030-01-01T00:00:00Z'});
  await store.reconcile(workspace,{sent:[sent],results:[{operationId:sent.operationId,ok:true,canonical:{id:42,syncId:'note',noteTitle:'first edit'}}],snapshot:{note:[{id:42,syncId:'note',noteTitle:'stale snapshot'}]},cursor:5});
  assert.equal((await store.listNotes(workspace.partition))[0].noteTitle,'later edit');
  assert.equal((await store.listReminders(workspace.partition))[0].noteId,42);
  assert.equal((await store.listOutbox(workspace.partition)).length,2);
  const db=await store.open(),original=db.transaction.bind(db);
  db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite') queueMicrotask(()=>tx.abort());return tx;};
  await assert.rejects(store.reconcile(workspace,{changes:[{sequence:6,resourceType:'note',resourceSyncId:'note',operation:'delete',payload:null}],cursor:6}));
  db.transaction=original;
  assert.equal((await store.getSyncState(workspace.partition)).cursor,5);
  assert.equal((await store.listNotes(workspace.partition))[0].noteTitle,'later edit');
  const remaining=await store.listOutbox(workspace.partition);
  await store.reconcile(workspace,{sent:remaining,results:remaining.map(entry=>({operationId:entry.operationId,ok:true,canonical:null})),changes:[{sequence:6,resourceType:'note',resourceSyncId:'note',operation:'delete',payload:null}],cursor:6});
  assert.equal((await store.listNotes(workspace.partition)).length,0);
  await store.reconcile(workspace,{snapshot:{note:[{id:42,syncId:'note',noteTitle:'obsolete snapshot'}]},cursor:3});
  assert.equal((await store.listNotes(workspace.partition)).length,0,'an older snapshot cannot resurrect a tombstone');
  assert.equal((await store.getSyncState(workspace.partition)).cursor,6);
});
test('backup snapshots stay consistent while edits continue, and staging cleanup does not delete active workspaces',async()=>{
  const store=createStore(),workspace=local();await store.saveWorkspace(workspace);
  await store.commitMutation(workspace,'note.upsert','note',{noteTitle:'before'});
  await store.commitMutation(workspace,'attachment.upsert','file',{noteId:1,noteSyncId:'note',originalName:'file.txt'},{blobs:[{key:'attachment:file',value:new Blob(['bytes'])}]});
  await store.putBlob(workspace.partition,'media:deleted-image',new Blob(['deleted']));
  const snapshot=await store.captureBackup(workspace);
  await store.commitMutation(workspace,'note.upsert','note',{noteTitle:'after'});
  let after,rows=[];
  while(true){const page=await store.snapshotPage(snapshot.id,after);if(!page.length)break;rows.push(...page);after=page.at(-1).key;}
  assert.equal(rows.find(row=>row.store==='notes').record.value.noteTitle,'before');
  assert.equal(await rows.find(row=>row.store==='blobs').record.value.text(),'bytes');
  assert.equal(rows.filter(row=>row.store==='blobs').length,1,'unreferenced/deleted media must not appear in a backup');
  await store.discardStaging(snapshot.id);
  assert.equal((await store.snapshotPage(snapshot.id)).length,0);
  await assert.rejects(store.discardStaging(workspace.id));
  assert.equal((await store.listNotes(workspace.partition))[0].noteTitle,'after');
});

test('native reminder occurrences keep the schedule version; external edits preserve locally changed fields',async()=>{
 const store=createStore(),workspace=await store.ensureServerWorkspace('server|1');
 await store.commitMutation(workspace,'reminder.upsert','reminder',{noteId:null,dueAtUtc:'2026-01-01T09:00:00.000Z',scheduleVersion:1,title:'Local title',body:'Old body',status:'pending'});
 const action={actionId:'occurrence',workspaceId:workspace.id,generation:workspace.generation,sequence:1,kind:'reminder.occurrence',targetSyncId:'reminder',payload:{dueAtUtc:'2026-01-01T09:00:00.000Z',nextDueAtUtc:'2026-01-02T09:00:00.000Z',occurrenceId:'reminder@2026-01-01T09:00:00.000Z#v1',scheduleVersion:1}};
 await store.commitMutation(workspace,'reminder.occurrence','reminder',{}, {action});
 const occurrence=(await store.listOutbox(workspace.partition)).find(entry=>entry.type==='reminder.occurrence');
 assert.equal(occurrence.payload.scheduleVersion,1);assert.equal(occurrence.payload.occurrenceDueAtUtc,action.payload.dueAtUtc);
 const external={...action,actionId:'apple-edit',kind:'reminder.upsert',payload:{base:{title:'Old title',body:'Old body'},changes:{title:'Apple title',body:'Apple body'}}};
 await store.commitMutation(workspace,'reminder.upsert','reminder',{title:'Apple title',body:'Apple body'},{action:external});
 const [reminder]=await store.listReminders(workspace.partition);assert.equal(reminder.title,'Local title');assert.equal(reminder.body,'Apple body');
 assert.equal((await store.listConflicts(workspace.partition)).length,1);
});

test('an additive schema upgrade preserves an existing outbox, cursor and blob',async()=>{
 const {IDBFactory}=require('fake-indexeddb');const factory=new IDBFactory();
 const old=await new Promise((resolve,reject)=>{const request=factory.open('kept-offline-v1',1);request.onupgradeneeded=()=>{for(const name of ['notes','reminders','attachments','savedPlaces','outbox','blobs','syncState']){const store=request.result.createObjectStore(name,{keyPath:'key'});store.createIndex('partition','partition');}};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 await new Promise((resolve,reject)=>{const tx=old.transaction(['outbox','blobs','syncState'],'readwrite');tx.objectStore('outbox').put({key:'server|legacy',partition:'server',operationId:'legacy',type:'note.upsert',syncId:'note',createdAt:1,payload:{noteTitle:'Unsent'}});tx.objectStore('blobs').put({key:'server|file',partition:'server',value:new Blob(['original'])});tx.objectStore('syncState').put({key:'server',partition:'server',cursor:123,serverOffsetMs:0});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
 old.close();const store=createStore(factory);
 assert.equal((await store.listOutbox('server'))[0].operationId,'legacy');
 assert.equal((await store.getSyncState('server')).cursor,123);
 assert.equal(await(await store.getBlob('server','file')).text(),'original');
 assert.equal((await store.open()).version,4);
});

test('fresh local libraries seed once, preserve sample files and can trash all demos together',async()=>{
 const {IDBFactory}=require('fake-indexeddb');const database=new IDBFactory();
 const store=createStore(database),workspace={...local(),demoNotesSeeded:false};await store.saveWorkspace(workspace);
 await Promise.all([store.seedLocalDemoNotes(workspace),store.seedLocalDemoNotes(workspace)]);
 const demos=await store.listNotes(workspace.partition);
 assert.equal(demos.length,7);assert.equal(demos.every(note=>note.isDemo),true);
 assert.equal((await store.getWorkspace(workspace.id)).demoNotesSeeded,true);
 const [label]=await store.listResources('label',workspace.partition);
 assert.equal(demos.find(note=>note.labels.length).labels[0].syncId,label.syncId);
 const [attachment]=await store.listResources('attachment',workspace.partition);
 assert.equal(attachment.originalName,'welcome.txt');
 assert.match(await(await store.getBlob(workspace.partition,`attachment:${attachment.syncId}`)).text(),/Welcome to Kept!/);
 assert.ok(demos.some(note=>note.images.some(image=>image.id==='drawing')));
 assert.equal((await store.listReminders(workspace.partition)).length,0,'setup does not schedule an alarm or request reminder permission');
 assert.equal((await store.listOutbox(workspace.partition)).length,0);
 const personal=await store.commitMutation(workspace,'note.upsert','personal',{noteTitle:'Keep my own note',pinned:false,labels:[]});
 // Exercise the same SharedService trash action used by the editor/menu.
 const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
 const {BehaviorSubject,Subject}=require('rxjs');
 const exports={};let prompted=0;
 const source=ts.transpileModule(fs.readFileSync('src/app/services/shared.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
 vm.runInNewContext(source,{exports,console,localStorage:{getItem:()=>null},confirm:()=>{prompted++;return true;},Snackbar:{show:()=>{}},require(name){
    if (name.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
  if(name==='@angular/core')return{Injectable:()=>target=>target};
  if(name==='rxjs')return{BehaviorSubject,Subject};
  if(name==='@popperjs/core')return{};
  if(name.endsWith('/environment'))return{environment:{apiUrl:'/api'}};
  if(name.endsWith('/demo-notes'))return{};
  throw Error(`Unexpected shared-service dependency: ${name}`);
 }});
 const notes={notesList$:new BehaviorSubject(await store.listNotes(workspace.partition)),updateKey:async(patch,id)=>{
  const note=(await store.listNotes(workspace.partition)).find(item=>item.id===id);
  await store.commitMutation(workspace,'note.upsert',note.syncId,{...note,...patch});
  notes.notesList$.next((await store.listNotes(workspace.partition)).filter(item=>!item.trashed));
 }};
 const shared=new exports.SharedService(notes,{labelsList$:new BehaviorSubject([])},{isLocal:true,workspace:{local:workspace},accessChanges$:new Subject()}, {},{run:fn=>fn()}, {items$:new BehaviorSubject([]),sharedItems$:new BehaviorSubject([]),sync:{writesLocally:true}});
 shared.note.id=demos[0].id;await shared.note.db.trash();
 assert.equal(prompted,1);
 const after=await store.listNotes(workspace.partition);
 assert.equal(after.filter(note=>note.isDemo&&note.trashed).length,7);
 assert.equal(after.find(note=>note.id===personal.id).trashed,undefined);
 await createStore(database).seedLocalDemoNotes(workspace);
 assert.equal((await store.listNotes(workspace.partition)).length,8,'reopening or trashing demos never reseeds');
});

test('interrupted demo seeding rolls back notes, files and marker together',async()=>{
 const store=createStore(),workspace={...local(),demoNotesSeeded:false};await store.saveWorkspace(workspace);
 const db=await store.open(),original=db.transaction.bind(db);
 db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
 await assert.rejects(store.seedLocalDemoNotes(workspace));db.transaction=original;
 assert.equal((await store.getWorkspace(workspace.id)).demoNotesSeeded,false);
 assert.equal((await store.listNotes(workspace.partition)).length,0);
 assert.equal((await store.listResources('label',workspace.partition)).length,0);
 assert.equal((await store.listResources('attachment',workspace.partition)).length,0);
 await store.seedLocalDemoNotes(workspace);assert.equal((await store.listNotes(workspace.partition)).length,7);
});

test('restored, staged, imported, existing and obsolete workspaces never receive demos',async()=>{
 for(const patch of [{demoNotesSeeded:true},{status:'staging',demoNotesSeeded:true},{demoNotesSeeded:undefined},{mode:'server',demoNotesSeeded:false},{revision:1,demoNotesSeeded:false}]){
  const store=createStore(),workspace={...local(),...patch};await store.saveWorkspace(workspace);
  await store.seedLocalDemoNotes(workspace);assert.equal((await store.listNotes(workspace.partition)).length,0);
 }
 const store=createStore(),workspace={...local(),demoNotesSeeded:false};await store.saveWorkspace(workspace);
 await store.seedLocalDemoNotes({...workspace,generation:'old'});
 assert.equal((await store.listNotes(workspace.partition)).length,0);
});

test('shared binder moves stay field-only while offline and do not overwrite newer content on reconciliation',async()=>{
  const store=createStore(),workspace=await store.ensureServerWorkspace('binder-member');
  const sharedBinder={id:12,name:'Together',ownerUserId:1,ownerDisplayName:'Owner',ownerUsername:'owner'};
  const note={id:25,syncId:'binder-note',ownerUserId:1,noteTitle:'Original',noteBody:'Original body',binder:'Together',sharedBinder};
  await store.reconcile(workspace,{snapshot:{note:[note]},cursor:1});
  await store.commitMutation(workspace,'note.binder',note.syncId,{binderId:null,binder:''});
  const [operation]=await store.listOutbox(workspace.partition);
  assert.equal(operation.type,'note.binder');
  assert.equal(Object.hasOwn(operation.payload,'noteBody'),false);
  assert.equal((await store.getNote(workspace.partition,25)).sharedBinder,undefined);
  await store.reconcile(workspace,{changes:[{sequence:2,resourceType:'note',resourceSyncId:note.syncId,operation:'upsert',payload:{...note,noteTitle:'Edited elsewhere',noteBody:'New body'},lww:{physicalMs:Date.now()+100}}],cursor:2});
  const local=await store.getNote(workspace.partition,25);
  assert.equal(local.noteTitle,'Edited elsewhere');assert.equal(local.noteBody,'New body');
  assert.equal(local.binder,'');assert.equal(local.sharedBinder,undefined);
  await store.reconcile(workspace,{sent:[operation],results:[{ok:true,operationId:operation.operationId,canonical:null}],cursor:3});
  assert.equal((await store.listOutbox(workspace.partition)).length,0);
  assert.equal(await store.getNote(workspace.partition,25),undefined,'losing binder-only access removes the cached note');
});

test('position-only sync preserves pending text, pins and attachments without reading the whole library',async t=>{
  const {IDBIndex}=require('fake-indexeddb');
  const store=createStore(),workspace=await store.ensureServerWorkspace('position-only');
  t.after(async()=>{(await store.open()).close();});
  const notes=[{id:1,syncId:'one',noteTitle:'Keep title',noteBody:'Keep text',pinned:true,sortOrder:10,labels:[],attachments:[],updatedAt:'2020-01-01T00:00:00Z'},
    {id:2,syncId:'two',noteTitle:'Second',sortOrder:9,labels:[],attachments:[]}];
  await store.reconcile(workspace,{snapshot:{note:notes},cursor:1});
  await store.commitMutation(workspace,'note.upsert','one',{...notes[0],noteBody:'Offline edit'});
  const [edit]=await store.listOutbox(workspace.partition);
  const getAll=IDBIndex.prototype.getAll;let noteReads=0,attachmentReads=0;
  IDBIndex.prototype.getAll=function(...args){if(this.objectStore.name==='notes')noteReads++;if(this.objectStore.name==='attachments')attachmentReads++;return getAll.apply(this,args);};
  t.after(()=>{IDBIndex.prototype.getAll=getAll;});
  const position=(sequence,id,syncId,sortOrder)=>({sequence,resourceType:'notePosition',resourceSyncId:syncId,operation:'upsert',payload:{id,syncId,sortOrder}});
  await store.reconcile(workspace,{changes:[position(2,1,'one',30)],cursor:2});
  assert.equal(noteReads,0);assert.equal(attachmentReads,0);
  let note=(await store.listNotes(workspace.partition)).find(note=>note.id===1);
  assert.equal(note.noteBody,'Offline edit');assert.equal(note.sortOrder,30);assert.equal(note.pinned,true);
  // A queued content edit carries its old sortOrder, but must not undo a move.
  await store.reconcile(workspace,{results:[{ok:true,operationId:edit.operationId,canonical:{...notes[0],noteBody:'Offline edit',sortOrder:30}}],sent:[edit]});
  note=(await store.listNotes(workspace.partition)).find(note=>note.id===1);
  assert.equal(note.noteBody,'Offline edit');assert.equal(note.sortOrder,30);
  // Another local move remains visible while older changes and acknowledgments arrive.
  await store.commitMutation(workspace,'note.reorder','note-order',{syncIds:['two','one']});
  const [move]=await store.listOutbox(workspace.partition);
  await store.reconcile(workspace,{changes:[position(3,1,'one',40),position(4,2,'two',39)],cursor:4});
  let current=await store.listNotes(workspace.partition);assert.ok(current.find(n=>n.id===2).sortOrder>current.find(n=>n.id===1).sortOrder);
  await store.reconcile(workspace,{results:[{ok:true,operationId:move.operationId,positions:[{id:2,syncId:'two',sortOrder:51},{id:1,syncId:'one',sortOrder:50}]}],sent:[move]});
  current=await store.listNotes(workspace.partition);assert.equal(current.find(n=>n.id===1).sortOrder,50);assert.equal(current.find(n=>n.id===2).sortOrder,51);
  // A bootstrap supersedes cached position overlays, without rewriting content.
  await store.reconcile(workspace,{snapshot:{note:[{...notes[0],sortOrder:90},notes[1]]},cursor:10});
  assert.equal((await store.listNotes(workspace.partition)).find(n=>n.id===1).sortOrder,90);
  // Obsolete pages cannot restore an earlier order.
  await store.reconcile(workspace,{changes:[position(2,1,'one',1)],cursor:2});
  assert.equal((await store.listNotes(workspace.partition)).find(n=>n.id===1).sortOrder,90);
});

test('position changes never fabricate missing notes; legacy position writes preserve full cached content',async()=>{
  const store=createStore(),workspace=await store.ensureServerWorkspace('missing-positions');
  try {
    assert.equal((await store.missingNotePositions(workspace.partition,[{id:7,syncId:'missing'}])).length,1);
    await store.reconcile(workspace,{changes:[{sequence:1,resourceType:'notePosition',resourceSyncId:'missing',operation:'upsert',payload:{id:7,syncId:'missing',sortOrder:77}}],cursor:1});
    assert.equal((await store.listNotes(workspace.partition)).length,0);
    await store.reconcile(workspace,{changes:[{sequence:2,resourceType:'note',resourceSyncId:'missing',operation:'upsert',payload:{id:7,syncId:'missing',noteBody:'Downloaded content',sortOrder:77}}],cursor:2});
    assert.equal((await store.missingNotePositions(workspace.partition,[{id:7,syncId:'missing'}])).length,0);
    await store.putNotePositions(workspace.partition,[{id:7,sortOrder:88},{id:100,sortOrder:99}]);
    const notes=await store.listNotes(workspace.partition);assert.equal(notes.length,1);assert.equal(notes[0].sortOrder,88);assert.equal(notes[0].noteBody,'Downloaded content');
  } finally {(await store.open()).close();}
});

test('rapid offline moves in the same millisecond retain logical order through pending overlays and upload',async()=>{
  const store=createStore(),workspace=await store.ensureServerWorkspace('rapid-order');
  try {
    await store.reconcile(workspace,{snapshot:{note:[{id:1,syncId:'one',sortOrder:2},{id:2,syncId:'two',sortOrder:1}]},cursor:1});
    let logical=0;
    store.nextStamp=()=>({physicalMs:123456,logical:logical++,deviceId:'same-device',operationId:logical===1?'z-first':'a-second'});
    await store.commitMutation(workspace,'note.reorder','note-order',{syncIds:['two','one']});
    await store.commitMutation(workspace,'note.reorder','note-order',{syncIds:['one','two']});
    assert.deepEqual(Array.from(await store.listOutbox(workspace.partition),entry=>entry.operationId),['z-first','a-second']);
    await store.reconcile(workspace,{changes:[{sequence:2,resourceType:'notePosition',resourceSyncId:'two',operation:'upsert',payload:{id:2,syncId:'two',sortOrder:50}}],cursor:2});
    const notes=await store.listNotes(workspace.partition);assert.ok(notes.find(n=>n.id===1).sortOrder>notes.find(n=>n.id===2).sortOrder);
  }finally{(await store.open()).close();}
});

test('single-note reads and writes use identity indexes, preserve full cached content and stay partitioned',async t=>{
  const {IDBIndex}=require('fake-indexeddb');
  const store=createStore(),workspace=await store.ensureServerWorkspace('indexed-notes');
  t.after(async()=>{(await store.open()).close();});
  const notes=Array.from({length:1000},(_,i)=>({id:i+1,syncId:`indexed-${i}`,noteTitle:`Note ${i}`,noteBody:'Full body',sortOrder:i,updatedAt:'2020-01-01T00:00:00Z'}));
  await store.reconcile(workspace,{snapshot:{note:notes},cursor:1});
  const getAll=IDBIndex.prototype.getAll;let scans=0;
  IDBIndex.prototype.getAll=function(...args){if(this.objectStore.name==='notes' && this.name==='partition')scans++;return getAll.apply(this,args);};
  t.after(()=>IDBIndex.prototype.getAll=getAll);
  assert.equal((await store.getNote(workspace.partition,500)).syncId,'indexed-499');
  assert.equal(await store.getNote('different-account',500),undefined);
  assert.equal((await store.getNoteBySyncId(workspace.partition,'indexed-499')).id,500);
  assert.equal(await store.getNoteBySyncId(workspace.partition,'missing'),undefined);
  await store.putNote(workspace.partition,{...notes[499],noteTitle:'New card title',noteBody:'',isCardPreview:true,updatedAt:'2021-01-01T00:00:00Z'});
  const full=await store.getNote(workspace.partition,500);
  assert.equal(full.noteBody,'Full body');assert.equal(full.isCardPreview,false);
  await store.overwriteNoteMetadata(workspace.partition,{...full,pinned:true});
  assert.equal((await store.getNote(workspace.partition,500)).pinned,true);
  assert.equal(scans,0,'targeted reads/writes never scan the notes partition');
  assert.equal((await store.getNote(workspace.partition,501)).noteTitle,'Note 500');
});

test('a known dragged note reads only its neighbours and writes one position in a thousand-note library',async t=>{
  const {IDBObjectStore}=require('fake-indexeddb');
  const store=createStore(),workspace=await store.ensureServerWorkspace('sparse-grid');
  t.after(async()=>{(await store.open()).close();});
  const notes=Array.from({length:1000},(_,i)=>({id:i+1,syncId:`drag-${i}`,sortOrder:3000-i,noteBody:`Unchanged image and text ${i}`,updatedAt:'2020-01-01T00:00:00Z'}));
  await store.reconcile(workspace,{snapshot:{note:notes},cursor:1});
  const get=IDBObjectStore.prototype.get,put=IDBObjectStore.prototype.put;let reads=0,writes=0;
  IDBObjectStore.prototype.get=function(...args){if(this.name==='notes')reads++;return get.apply(this,args);};
  IDBObjectStore.prototype.put=function(...args){if(this.name==='notes')writes++;return put.apply(this,args);};
  t.after(()=>{IDBObjectStore.prototype.get=get;IDBObjectStore.prototype.put=put;});
  const order=notes.map(note=>note.syncId);order.splice(10,0,order.splice(800,1)[0]);
  const value=await store.commitMutation(workspace,'note.reorder','note-order',{syncIds:order,movedSyncId:'drag-800'});
  assert.equal(reads,3);assert.equal(writes,1);assert.equal(value.positions.length,1);
  assert.equal(value.positions[0].syncId,'drag-800');
  const moved=await store.getNoteBySyncId(workspace.partition,'drag-800');
  assert.equal(moved.noteBody,notes[800].noteBody);assert.equal(moved.updatedAt,notes[800].updatedAt);
  const {notePositionsForOrder}=require('../shared/note-order');
  const server=notePositionsForOrder(order.map(id=>notes.find(note=>note.syncId===id)),Date.now(),'drag-800');
  assert.equal(moved.sortOrder,server[0].sortOrder);
  const sorted=Array.from(await store.listNotes(workspace.partition)).sort((a,b)=>b.sortOrder-a.sortOrder);
  assert.deepEqual(sorted.map(note=>note.syncId),order);
});
