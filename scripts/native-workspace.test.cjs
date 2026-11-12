const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),rx=require('rxjs');
const source=ts.transpileModule(fs.readFileSync('src/app/services/native-workspace.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
function harness(platform = 'android', imageRuntime = {}) {
 const values=new Map(),exports={},settings=[];
 const window=new EventTarget(),document=Object.assign(new EventTarget(),{visibilityState:'visible'},imageRuntime.document);
 vm.runInNewContext(source,{exports,console,window,document,Image:imageRuntime.Image,URL:imageRuntime.URL || URL,TextEncoder,setTimeout,clearTimeout,Error,Date,Promise,Blob,atob,localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},require(name){
    if (name.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
  if(name.endsWith('/note-images'))return require('../test-support/note-images.cjs').loadNoteImages(imageRuntime);
  if(name==='@angular/core')return{Injectable:()=>target=>target};
  if(name==='@capacitor/core')return{Capacitor:{isNativePlatform:()=>false,getPlatform:()=>platform},registerPlugin:name=>({openBackgroundLocationSettings:async()=>settings.push(name)})};
  if(name==='rxjs')return rx;
  if(name.endsWith('/note-html'))return{sanitizeNoteHtml:value=>value || '',createNoteHtmlContainer:()=>({innerHTML:'',querySelector(){const match=this.innerHTML.match(/<img\b[^>]*src=["']([^"']+)["']/i);return match?{getAttribute:()=>match[1]}:null;}})};
  if(name==='@noble/hashes/sha2.js')return{sha256:value=>require('node:crypto').createHash('sha256').update(value).digest()};
  if(name==='@noble/hashes/utils.js')return{bytesToHex:value=>Buffer.from(value).toString('hex')};
  if(name.endsWith('/uuid')||name.endsWith('/attachments'))return{};
  throw Error(`Unexpected native-workspace dependency: ${name}`);
 }});
 const workspace={id:'device',partition:'local:device',generation:'first',status:'active',revision:10};
 const sync={partition:workspace.partition,generation:workspace.generation,cacheChanged$:new rx.Subject(),workspace:async()=>({...workspace})};
 const store={getWorkspace:async()=>({...workspace}),nativeProjection:async()=>({workspace:{...workspace},notes:[{id:1,syncId:'note'}]}),getBlob:async()=>undefined};
 const native=new exports.NativeWorkspaceService({accessChanges$:new rx.Subject(),canonicalImageUrl:value=>value,authenticatedImageUrl:value=>value},sync,store,{run:fn=>fn()});
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
test('confirmed exact-alarm permission clears its warning; an omitted permission result does not',async()=>{
 const h=harness();
 h.native.plugin.syncReminders=async()=>({exact:false});await h.native.syncReminders([]);
 const warning=h.native.error$.value;assert.match(warning,/exact-alarm/);
 h.native.plugin.syncReminders=async()=>({});await h.native.syncReminders([]);
 assert.equal(h.native.error$.value,warning);
 h.native.plugin.syncReminders=async()=>({exact:true});await h.native.syncReminders([]);
 assert.equal(h.native.error$.value,'');
});
test('exact-alarm recovery never clears unrelated errors or errors from the current sync',async()=>{
 const h=harness();h.native.plugin.syncReminders=async()=>({exact:true});
 for(const error of ['Existing storage failure','Could not open exact-alarm settings.']) {
  h.native.error$.next(error);await h.native.syncReminders([]);assert.equal(h.native.error$.value,error);
 }
 h.native.plugin.syncReminders=async()=>({exact:true,skipped:[{id:'bad',reason:'invalid'}]});
 await h.native.syncReminders([]);assert.match(h.native.error$.value,/Invalid native reminder: bad/);
});
test('an obsolete permission-granted response cannot clear the active workspace warning',async()=>{
 const h=harness();h.native.plugin.syncReminders=async()=>({exact:false});await h.native.syncReminders([]);
 const warning=h.native.error$.value;
 h.native.plugin.syncReminders=async()=>{h.sync.generation='next';return{exact:true};};
 await h.native.syncReminders([]);assert.equal(h.native.error$.value,warning);
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

for (const platform of ['ios','android']) test(`${platform}: a shared HEIC is committed as a JPEG image, not an attachment`,async()=>{
 const jpeg=new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'});
 const h=harness(platform,{
  createImageBitmap:async()=>({width:2,height:2,close(){}}),
  document:{createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}}),toBlob(callback){callback(jpeg);}})}
 });
 const bytes=Buffer.from('000000186674797068656963000000006d69663168656963','hex');
 h.native.plugin.readFileChunk=async()=>({base64:bytes.toString('base64')});
 h.store.listNotes=async()=>[];
 let captured;
 h.sync.commit=async(type,id,value,options)=>{captured={type,id,value,options};};
 await h.native.applyAction(h.workspace,{actionId:'photo-share',workspaceId:h.workspace.id,generation:h.workspace.generation,
  sequence:1,kind:'note.upsert',targetSyncId:'shared-photo',payload:{noteTitle:'Photo'},
  files:[{reference:'opaque-file',name:'IMG_0001.HEIC',size:bytes.length,mimeType:'image/heic'}]});
 assert.equal(captured.type,'note.upsert');
 assert.equal(captured.value.images.length,1);
 assert.equal(captured.value.images[0].name,'IMG_0001.jpg');
 assert.equal(captured.options.blobs[0].value.type,'image/jpeg');
 assert.equal(captured.options.attachments.length,0);
});

function thumbnailRuntime(width = 400, height = 200) {
 const state={renders:[],draws:[],loaded:[],revoked:[],fail:false};
 class Image {
  naturalWidth=width;naturalHeight=height;
  set src(value){if(value){state.loaded.push(value);Promise.resolve().then(()=>state.fail?this.onerror?.():this.onload?.());}}
 }
 const runtime={Image,URL:{createObjectURL:()=>`blob:widget-${state.loaded.length}`,revokeObjectURL:url=>state.revoked.push(url)},
  document:{createElement:()=>({width:0,height:0,getContext(){return{fillRect(){},drawImage(_image,_x,_y,width,height){state.draws.push([width,height]);}};},
   toDataURL(type,quality){state.renders.push([type,quality]);return 'data:image/jpeg;base64,dGh1bWI=';}})}};
 return{state,runtime};
}
function thumbnailHarness(platform, width, height) {
 const {state,runtime}=thumbnailRuntime(width,height),h=harness(platform,runtime),pages=[];
 let notes=[];
 h.store.getBlob=async()=>new Blob(['image'],{type:'image/png'});
 h.store.nativeProjection=async()=>({workspace:{...h.workspace},notes});
 h.native.plugin.publishSnapshot=async page=>pages.push(page);
 return {...h,state,pages,setNotes(value){notes=value;}};
}
for(const platform of ['ios','android']) test(`${platform}: snapshots use a cached 128px JPEG from the first image and never expose locked-note thumbnails`,async()=>{
 const h=thumbnailHarness(platform),image={id:'photo',dataUrl:'/__kept_local_media/first',placement:'top'};
 h.setNotes([{id:1,syncId:'photo-note',images:[image,{...image,id:'other',dataUrl:'/second'}]},
  {id:2,syncId:'same-image',images:[image]},
  {id:3,syncId:'locked',locked:true,noteTitle:'Secret',noteBody:'Secret body',images:[{...image,dataUrl:'/secret'}],thumbnailDataUrl:'must-not-leak'}]);
 await h.native.publish(h.workspace);
 assert.equal(h.state.loaded.length,1,'reused images are generated once');
 assert.deepEqual(h.state.draws,[[128,64]]);assert.deepEqual(h.state.renders,[['image/jpeg',0.8]]);
 assert.equal(h.pages[0].notes[0].thumbnailDataUrl,'data:image/jpeg;base64,dGh1bWI=');
 assert.equal(h.pages[0].notes[1].thumbnailDataUrl,h.pages[0].notes[0].thumbnailDataUrl);
 assert.deepEqual(Object.keys(h.pages[0].notes[2]).sort(),['archived','id','locked','syncId','trashed']);
 assert.deepEqual([...h.pages[0].notes[0].images],[]);
 assert.deepEqual(h.state.revoked,h.state.loaded,'temporary source URLs are released');
 h.workspace.revision++;await h.native.publish(h.workspace);assert.equal(h.state.loaded.length,1,'ordinary edits reuse thumbnails');
 image.dataUrl='/__kept_local_media/replaced';h.workspace.revision++;await h.native.publish(h.workspace);assert.equal(h.state.loaded.length,2,'a replaced image gets a new thumbnail');
 h.workspace.generation='next';h.sync.generation='next';await h.native.publish(h.workspace);assert.equal(h.state.loaded.length,3,'generation changes do not reuse the old library cache');
});
test('inline images and large data URLs get thumbnails without making a network request',async()=>{
 const h=thumbnailHarness('ios',200,400);let keys=[];
 h.store.getBlob=async(_partition,key)=>{keys.push(key);return undefined;};
 h.setNotes([{id:1,noteBody:'<p><img src="data:image/png;base64,YQ=="></p>'},
  {id:2,images:[{dataUrl:'data:image/png;base64,'+'YQ=='.repeat(500)}]}]);
 await h.native.publish(h.workspace);
 assert.deepEqual(h.state.draws,[[64,128],[64,128]]);
 assert.ok(h.pages[0].notes.every(note=>note.thumbnailDataUrl));assert.equal(keys.length,2);
});
test('failed or unavailable thumbnails are omitted without failing the snapshot, and failed images can recover',async()=>{
 const h=thumbnailHarness('android');h.state.fail=true;
 h.setNotes([{id:1,images:[{dataUrl:'/cached'}],thumbnailDataUrl:'stale-thumbnail'}]);
 await h.native.publish(h.workspace);assert.equal('thumbnailDataUrl' in h.pages[0].notes[0],false);
 h.state.fail=false;h.workspace.revision++;await h.native.publish(h.workspace);
 assert.ok(h.pages[1].notes[0].thumbnailDataUrl);
 h.store.getBlob=async()=>undefined;h.setNotes([{id:2,images:[{dataUrl:'https://unavailable.example/photo.jpg'}]}]);
 h.workspace.revision++;await h.native.publish(h.workspace);
 assert.equal('thumbnailDataUrl' in h.pages[2].notes[0],false);assert.equal(h.state.loaded.length,2,'uncached remote images are not downloaded');
});
test('locking a note or switching workspaces while a thumbnail is generated prevents publishing the old content',async()=>{
 for(const change of [(h,note)=>{note.locked=true;h.workspace.revision++;},h=>{h.sync.partition='different';},h=>{h.sync.generation='different';}]) {
  const h=thumbnailHarness('ios');let release,started;
  const entered=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
  h.store.getBlob=async()=>{started();await blocked;return new Blob(['image']);};
  const note={id:1,images:[{dataUrl:'/cached'}]};h.setNotes([note]);
  const pending=h.native.publish(h.workspace);await entered;change(h,note);release();await pending;
  assert.equal(h.pages.length,0);
  if(note.locked) {
   await h.native.publish(h.workspace);assert.equal(h.pages[0].notes[0].locked,true);
   assert.equal('thumbnailDataUrl' in h.pages[0].notes[0],false);
  }
 }
});
