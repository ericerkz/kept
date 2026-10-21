const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),rx=require('rxjs');
const source=ts.transpileModule(fs.readFileSync('src/app/services/native-workspace.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
function harness() {
 const values=new Map(),exports={},settings=[];
 const window=new EventTarget(),document=Object.assign(new EventTarget(),{visibilityState:'visible'});
 vm.runInNewContext(source,{exports,console,window,document,Error,Date,Promise,localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},require(name){
  if(name==='@angular/core')return{Injectable:()=>target=>target};
  if(name==='@capacitor/core')return{Capacitor:{isNativePlatform:()=>false,getPlatform:()=> 'android'},registerPlugin:name=>({openBackgroundLocationSettings:async()=>settings.push(name)})};
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
