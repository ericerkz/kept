import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {startFixture} from '../test-support/session-fixture.cjs';
const bundle=await build({stdin:{contents:`import {OfflineStoreService} from './src/app/services/offline-store.service';
import {WorkspaceService} from './src/app/services/workspace.service';
import {WorkspaceBackupService} from './src/app/services/workspace-backup.service';
import {NativeWorkspaceService} from './src/app/services/native-workspace.service';
import {BehaviorSubject,Subject} from 'rxjs';
window.testWorkspace={OfflineStoreService,WorkspaceService,WorkspaceBackupService,NativeWorkspaceService,BehaviorSubject,Subject};`,resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',write:false,tsconfigRaw:{compilerOptions:{experimentalDecorators:true,baseUrl:'.'}},plugins:[{name:'angular-test',setup(build){build.onResolve({filter:/^@angular\/core$/},()=>({path:'angular',namespace:'test'}));build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const Injectable=()=>target=>target;'}));}}]});
const fixture=await startFixture();let browser;
try {
 browser=await chromium.launch({headless:true});const context=await browser.newContext({serviceWorkers:'block'});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 if(process.argv.includes('--large-backup')) await (await context.newCDPSession(page)).send('Storage.overrideQuotaForOrigin',{origin:fixture.origin,quotaSize:8*1024**3});
 await page.route('**/__workspace-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Workspace regression tests</title>'}));
 await page.goto(fixture.origin+'/__workspace-test');await page.addScriptTag({content:bundle.outputFiles[0].text});
 const result=await page.evaluate(async()=>{
  const {OfflineStoreService,WorkspaceService,WorkspaceBackupService}=window.testWorkspace;
  const store=new OfflineStoreService(),workspaces=new WorkspaceService(store);await workspaces.ready;
  const source=await workspaces.createLocal();
  const native={flush:async()=>{},ready:Promise.resolve()};
  const backups=new WorkspaceBackupService(store,workspaces,native);
  const note=await store.commitMutation(source,'note.upsert','note-portable',{noteTitle:'Portable note',noteBody:'<p>Stored locally</p>',pinned:false,isCbox:true,bgColor:'',bgImage:'',labels:[],checkBoxes:[{id:25,data:'Indented',done:false,indentLevel:2}],locked:true,lockSalt:'salt',lockHash:'hash'});
  await store.commitMutation(source,'binder.upsert','empty-binder',{name:'Empty binder'});
  await store.commitMutation(source,'attachment.upsert','file-portable',{noteId:note.id,noteSyncId:note.syncId,originalName:'file.txt',mimeType:'text/plain',fileSize:5},{blobs:[{key:'attachment:file-portable',value:new Blob(['bytes'],{type:'text/plain'})}]});
  const directory=await navigator.storage.getDirectory();const handle=await directory.getFileHandle('backup.zip',{create:true});
  let writes=0,maxChunk=0;
  const file=await handle.createWritable();
  await backups.exportToStream(new WritableStream({write:chunk=>{writes++;maxChunk=Math.max(maxChunk,chunk.length);return file.write(chunk);},close:()=>file.close()}));
  const restored=await backups.restoreFromBlob(await handle.getFile());
  const notes=await store.listNotes(restored.partition);
  if(notes[0].syncId!=='note-portable'||notes[0].checkBoxes[0].indentLevel!==2||!notes[0].locked)throw Error('Restore lost note fields');
  if(await(await store.getBlob(restored.partition,'attachment:file-portable')).text()!=='bytes')throw Error('Restore lost file');
  if((await store.listResources('binder',restored.partition))[0].name!=='Empty binder')throw Error('Restore lost empty binder');
  const sourceNotes=await store.listNotes(source.partition);
  if(sourceNotes.length!==1)throw Error('Restore modified the source workspace');
  let corruptRejected=false;
  try{await backups.restoreFromBlob(new Blob(['invalid zip']));}catch{corruptRejected=true;}
  if(!corruptRejected||workspaces.local.id!==restored.id)throw Error('Invalid restore changed the active workspace');
  await directory.removeEntry('backup.zip');
  window.keptTestStore=store;window.keptTestWorkspaces=workspaces;window.keptTestBackups=backups;
  return {writes,maxChunk,id:restored.id};
 });
 assert.ok(result.writes>1);assert.ok(result.maxChunk<=1048576);console.log('PASS actual IndexedDB: plain ZIP64 export, staged restore, media, locks, empty binders, invalid archive preservation');
 const nativeResult=await page.evaluate(async()=>{
  const {NativeWorkspaceService,BehaviorSubject,Subject}=window.testWorkspace;
  const store=window.keptTestStore,workspaces=window.keptTestWorkspaces;
  const workspace=await workspaces.createLocal();
  const note=await store.commitMutation(workspace,'note.upsert','widget-note',{noteTitle:'Widget',checkBoxes:[{id:1,data:'keep',done:false}],labels:[]});
  const access=new Subject(),changed=new Subject();
  const auth={accessChanges$:access,isLocal:true,workspace:workspaces};
  const sync={partition:workspace.partition,cacheChanged$:changed,workspace:()=>store.getWorkspace(workspace.id),commit:(type,id,payload,options)=>store.commitMutation(workspace,type,id,payload,options)};
  const native=new NativeWorkspaceService(auth,sync,store,{run:fn=>fn()});
  const actions=[{actionId:'widget-checked',workspaceId:workspace.id,generation:workspace.generation,sequence:1,kind:'checklist.set',targetSyncId:'widget-note',payload:{checkboxId:1,done:true}}];
  let failAcknowledgement=true,quarantined=0;
  native.plugin={activateWorkspace:async()=>{},listActions:async()=>({actions:[...actions]}),acknowledgeActions:async()=>{if(failAcknowledgement){failAcknowledgement=false;throw Error('Simulated crash before acknowledgement');}actions.shift();},quarantineActions:async()=>{quarantined++;actions.shift();},publishSnapshot:async()=>{}};
  native.capabilities$.next({version:1,durableActions:true,workspaceSnapshots:true});
  try{await native.flush();}catch{}
  if(!await store.hasReceipt(workspace.partition,'widget-checked'))throw Error('Receipt was not committed');
  const revision=(await store.getWorkspace(workspace.id)).revision;
  await native.flush();
  if((await store.getWorkspace(workspace.id)).revision!==revision)throw Error('Native replay changed the note twice');
  if(!(await store.listNotes(workspace.partition))[0].checkBoxes[0].done)throw Error('Widget set action was lost');
  if(quarantined)throw Error('Acknowledgement transport failure was incorrectly quarantined');
  actions.push({actionId:'obsolete',workspaceId:workspace.id,generation:'old-generation',sequence:2,kind:'note.delete',targetSyncId:'widget-note',payload:{}});
  await native.flush();
  if((await store.listNotes(workspace.partition)).length!==1 || quarantined!==1)throw Error('Obsolete native action affected a current note');
  return {revision};
 });
 console.log('PASS native bridge: crash after commit/before acknowledgement replays once; obsolete-generation actions are quarantined');
 if(process.argv.includes('--large-backup')){
  const large=await page.evaluate(async()=>{
   const store=window.keptTestStore,workspaces=window.keptTestWorkspaces,backups=window.keptTestBackups;
   const source=await workspaces.createLocal();
   const note=await store.commitMutation(source,'note.upsert','large-note',{noteTitle:'Large backup',labels:[],images:[]});
   const chunk=new Blob([new Uint8Array(24*1024*1024)],{type:'application/octet-stream'});
   for(let i=0;i<45;i++)await store.commitMutation(source,'attachment.upsert',`large-${i}`,{noteId:note.id,noteSyncId:note.syncId,originalName:`file-${i}.zip`,fileSize:chunk.size,mimeType:'application/zip'},{blobs:[{key:`attachment:large-${i}`,value:chunk}]});
   const directory=await navigator.storage.getDirectory(),handle=await directory.getFileHandle('large.zip',{create:true}),file=await handle.createWritable();
   let maxChunk=0,total=0;const start=performance.now();
   await backups.exportToStream(new WritableStream({write:bytes=>{maxChunk=Math.max(maxChunk,bytes.length);total+=bytes.length;return file.write(bytes);},close:()=>file.close()}));
   const restored=await backups.restoreFromBlob(await handle.getFile());
   const count=(await store.listResources('attachment',restored.partition)).length;
   await directory.removeEntry('large.zip');return{total,maxChunk,count,seconds:Math.round((performance.now()-start)/1000)};
  });
  assert.ok(large.total>1024**3);assert.ok(large.maxChunk<=1048576);assert.equal(large.count,45);console.log('PASS >1 GiB streamed backup and staged restore',large);
 }
 // Open the production application against the selected, real local partition.
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const api=[];page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))api.push(request.url());});
 await page.goto(fixture.origin,{waitUntil:'domcontentloaded'});
 await page.locator('app-notes').waitFor();
 await page.getByText('Saved on this device',{exact:true}).waitFor();
 await page.locator('app-input .placeholder:visible').click();
 const editor=page.locator('app-input .note-main:visible').last();
 await editor.getByRole('textbox',{name:'Title',exact:true}).fill('Created with no account');
 await editor.locator('.note-body[contenteditable]').fill('No server login or user identity.');
 await editor.getByRole('button',{name:'Close',exact:true}).click();
 await editor.waitFor({state:'hidden'});
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('app-notes').getByText('Created with no account',{exact:true}).waitFor();
 assert.deepEqual(api,[],'local mode must not issue Kept API requests');assert.deepEqual(errors,[]);
 console.log('PASS production UI: account-free local note creation and reload, no Kept API requests');
 await context.addInitScript(()=>{window.CapacitorCustomPlatform={name:'android'};});
 await page.goto(fixture.origin+'/settings',{waitUntil:'domcontentloaded'});
 await page.getByRole('heading',{name:'Notes on this device',exact:true}).waitFor();
 assert.equal(await page.getByText('Delete your account',{exact:true}).count(),0);
 assert.equal(await page.getByText('Import from Google Keep',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Save a complete backup',exact:true}).click();
 await page.getByText('Update the native Kept app to save a complete device backup.',{exact:true}).waitFor();
 console.log('PASS local mobile settings: server-only groups hidden; missing native file capability is gated honestly');
 for (const platform of ['ios','android']) {
   const fresh=await browser.newContext({serviceWorkers:'block'});
   await fresh.addInitScript(name=>{window.CapacitorCustomPlatform={name};localStorage.setItem('kept_notification_permission_prompt_dismissed','1');},platform);
   const first=await fresh.newPage();first.setDefaultTimeout(15000);
   const calls=[];first.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))calls.push(request.url());});
   await first.goto(fixture.origin,{waitUntil:'domcontentloaded'});
   await first.getByRole('button',{name:'Use on this device',exact:true}).click();
   await first.locator('app-notes').waitFor();
   await first.getByText('Saved on this device',{exact:true}).waitFor();
   assert.deepEqual(calls,[]);console.log(`PASS ${platform} first-install emulation: welcome → device workspace, no account/server request`);
   await fresh.close();
 }
 await context.close();
}finally{await browser?.close();await fixture.close();}
