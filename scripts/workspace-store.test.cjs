const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createStore}=require('../test-support/workspace-store.cjs');
const local=()=>({id:'device',partition:'local:device',mode:'local',generation:'first',status:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),preferences:{theme:'light',followSystemTheme:true,showPastReminders:false},nextId:1,revision:0});
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
 assert.equal((await store.open()).version,3);
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
 const shared=new exports.SharedService(notes,{labelsList$:new BehaviorSubject([])},{isLocal:true,workspace:{local:workspace},accessChanges$:new Subject()}, {},{run:fn=>fn()}, {items$:new BehaviorSubject([]),sync:{writesLocally:true}});
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
