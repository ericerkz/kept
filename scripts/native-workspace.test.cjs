const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),rx=require('rxjs');
const source=ts.transpileModule(fs.readFileSync('src/app/services/native-workspace.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
function harness(platform = 'android') {
 const values=new Map(),exports={},settings=[];
 const window=new EventTarget(),document=Object.assign(new EventTarget(),{visibilityState:'visible'});
 vm.runInNewContext(source,{exports,console,window,document,Error,Date,Promise,localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},require(name){
  if(name==='@angular/core')return{Injectable:()=>target=>target};
  if(name==='@capacitor/core')return{Capacitor:{isNativePlatform:()=>false,getPlatform:()=>platform},registerPlugin:name=>({openBackgroundLocationSettings:async()=>settings.push(name)})};
  if(name==='rxjs')return rx;
  if(name==='@noble/hashes/sha2.js'||name==='@noble/hashes/utils.js'||name.endsWith('/uuid')||name.endsWith('/note-html')||name.endsWith('/attachments'))return{};
  throw Error(`Unexpected native-workspace dependency: ${name}`);
 }});
 const workspace={id:'device',partition:'local:device',generation:'first',status:'active',revision:10};
 const sync={partition:workspace.partition,generation:workspace.generation,cacheChanged$:new rx.Subject(),workspace:async()=>({...workspace})};
 const store={getWorkspace:async()=>({...workspace}),nativeProjection:async()=>({workspace:{...workspace},notes:[{id:1,syncId:'note'}]})};
 const native=new exports.NativeWorkspaceService({accessChanges$:new rx.Subject()},sync,store,{run:fn=>fn()});
 native.plugin={activateWorkspace:async()=>{},publishSnapshot:async()=>{},syncReminders:async()=>({})};
 native.capabilities$.next({version:1,workspaceSnapshots:true});
 return {native,workspace,sync,store,settings};
}
test('location permission skips are actionable and clear on successful resync; otherWorkspace stays benign',async()=>{
 const h=harness();h.native.error$.next('Existing storage failure');
 h.native.plugin.syncReminders=async()=>({skipped:[{id:'location',reason:'locationPermissionRequired'},{id:'unrelated',reason:'otherWorkspace'}]});
 await h.native.syncReminders([]);assert.equal(h.native.locationPermissionRequired$.value,true);
 assert.equal(h.native.error$.value,'Existing storage failure');
 await h.native.openBackgroundLocationSettings();assert.deepEqual(h.settings,['KeptGeofence']);
 h.native.plugin.syncReminders=async()=>({skipped:[{id:'unrelated',reason:'otherWorkspace'}]});
 await h.native.syncReminders([]);assert.equal(h.native.locationPermissionRequired$.value,false);
 assert.equal(h.native.error$.value,'Existing storage failure');
});
test('an obsolete reminder-sync response cannot change current permission state',async()=>{
 const h=harness();h.native.plugin.syncReminders=async()=>{h.sync.generation='next';return{skipped:[{id:'old',reason:'locationPermissionRequired'}]};};
 await h.native.syncReminders([]);assert.equal(h.native.locationPermissionRequired$.value,false);
});
test('malformed payload and exact-alarm warnings still surface',async()=>{
 const h=harness();h.native.plugin.syncReminders=async()=>({skipped:[{id:'bad',reason:'invalid'}]});
 await h.native.syncReminders([]);assert.match(h.native.error$.value,/Invalid native reminder: bad/);
 h.native.plugin.syncReminders=async()=>({exact:false});await h.native.syncReminders([]);
 assert.match(h.native.error$.value,/exact-alarm/);
});
test('explicit stale/inactive snapshot rejections are harmless and are not cached as published',async()=>{
 for(const code of ['STALE_SNAPSHOT','INACTIVE_WORKSPACE']) {
  const h=harness();h.native.plugin.publishSnapshot=async()=>{throw Object.assign(new Error('Rejected snapshot'),{code});};
  await h.native.publish(h.workspace);assert.equal(h.native.error$.value,'');
  let calls=0;h.native.plugin.publishSnapshot=async()=>{calls++;};
  await h.native.publish(h.workspace);await h.native.publish(h.workspace);assert.equal(calls,1);
 }
});
test('snapshot rejection is harmless when newer edits or workspace switches win the race',async()=>{
 for(const change of [h=>h.workspace.revision++,h=>h.workspace.status='retained',h=>h.workspace.generation='next',h=>h.sync.partition='other']) {
  const h=harness();h.native.plugin.publishSnapshot=async()=>{change(h);throw Error('Snapshot was rejected');};
  await h.native.publish({...h.workspace});assert.equal(h.native.error$.value,'');
 }
});
test('current snapshot storage failures remain visible instead of being swallowed',async()=>{
 const h=harness();h.native.plugin.publishSnapshot=async()=>{throw Error('Native storage is full');};
 await assert.rejects(h.native.publish(h.workspace),/Native storage is full/);
});

test('device reminders are suppressed in Trash/archive, preserved in storage and rescheduled on restore',async()=>{
 const {createStore}=require('../test-support/workspace-store.cjs');
 for(const platform of ['ios','android']) {
  const h=harness(platform),store=createStore();
  Object.assign(h.workspace,{mode:'local',nextId:1,createdAt:new Date().toISOString(),preferences:{}});
  await store.saveWorkspace(h.workspace);
  h.store.nativeProjection=workspace=>store.nativeProjection(workspace);
  h.sync.workspace=()=>store.getWorkspace(h.workspace.id);
  const note=await store.commitMutation(h.workspace,'note.upsert','note',{noteTitle:'Reminder note',trashed:false,archived:false});
  const other=await store.commitMutation(h.workspace,'note.upsert','other',{noteTitle:'Unrelated note'});
  for(const [syncId,fields] of [['time',{dueAtUtc:'2030-01-01T12:00:00Z',repeatRule:'{"type":"daily"}'}],['location',{locationName:'Home',latitude:1,longitude:2}]]) {
   await store.commitMutation(h.workspace,'reminder.upsert',syncId,{noteId:note.id,status:'pending',...fields});
  }
  await store.commitMutation(h.workspace,'reminder.upsert','other-reminder',{noteId:other.id,status:'pending'});
  await store.commitMutation(h.workspace,'reminder.upsert','standalone',{noteId:null,status:'pending'});
  const reminders=await store.listReminders(h.workspace.partition),scheduled=new Set(),cancelled=[];
  h.native.plugin.syncReminders=async({reminders})=>{scheduled.clear();for(const reminder of reminders)scheduled.add(reminder.reminderSyncId);return{};};
  h.native.plugin.cancelReminders=async input=>{cancelled.push(input);for(const id of input.reminderSyncIds)scheduled.delete(id);};
  await h.native.syncReminders(reminders);assert.equal(scheduled.size,4);
  for(const inactive of [{trashed:true,archived:false},{trashed:false,archived:true}]) {
   await store.commitMutation(h.workspace,'note.upsert','note',{...note,...inactive});
   // The original reminder list still includes the now-hidden note's reminders.
   await h.native.syncReminders(reminders);
   assert.deepEqual([...scheduled].sort(),['other-reminder','standalone']);
   assert.deepEqual(cancelled.at(-1).reminderSyncIds.sort(),['location','time']);
   assert.equal(cancelled.at(-1).workspaceId,h.workspace.id);assert.equal(cancelled.at(-1).generation,h.workspace.generation);
   assert.notEqual(cancelled.at(-1).dismissOnly,true,'future schedules must be cancelled too');
   assert.deepEqual(await store.listReminders(h.workspace.partition),reminders,'suppression must not delete or complete reminders');
   await store.commitMutation(h.workspace,'note.upsert','note',{...note,trashed:false,archived:false});
   await h.native.syncReminders(reminders);assert.equal(scheduled.size,4,'restore makes the unchanged reminders eligible again');
  }
  // Reopening starts from persisted lifecycle state, with no overview callback.
  await store.commitMutation(h.workspace,'note.upsert','note',{...note,trashed:true});
  const reopened=harness(platform);reopened.store.nativeProjection=workspace=>store.nativeProjection(workspace);reopened.sync.workspace=h.sync.workspace;reopened.native.plugin=h.native.plugin;
  await reopened.native.syncReminders(await store.listReminders(h.workspace.partition));
  assert.deepEqual([...scheduled].sort(),['other-reminder','standalone']);
 }
});

test('overlapping native reminder syncs serialize cancellation and recover after a failure',async()=>{
 const h=harness();let release,started,active=0,maximum=0,calls=0;
 const entered=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
 h.native.plugin.syncReminders=async()=>{calls++;maximum=Math.max(maximum,++active);try{if(calls===1){started();await blocked;throw Error('Transient native failure');}return{};}finally{active--;}};
 const first=h.native.syncReminders([]);await entered;
 const second=h.native.syncReminders([]);await Promise.resolve();assert.equal(calls,1);
 const rejected=assert.rejects(first,/Transient native failure/);release();await rejected;await second;
 assert.equal(maximum,1);assert.equal(calls,2);
});
