const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createStore } = require('../test-support/workspace-store.cjs');

function loadClass(file, name) {
  const exports = {};
  const decorator = () => value => value;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console: { ...console, error() {} }, require(id) {
    if (id === '@angular/core') return { Injectable: decorator, Component: decorator, ViewChild: () => () => {},
      Input: () => () => {}, HostBinding: () => () => {}, HostListener: () => () => {} };
    if (id === '@capacitor/core') return { registerPlugin: () => ({}) };
    if (id.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
    if (id.endsWith('/checkbox-indent')) return loadClass('src/app/utils/checkbox-indent.ts');
    if (id.endsWith('/checklist-placement')) return loadClass('src/app/utils/checklist-placement.ts');
    return {};
  } });
  return name ? exports[name] : exports;
}
const Notes = loadClass('src/app/services/notes.service.ts', 'NotesService');
const Input = loadClass('src/app/components/input/input.component.ts', 'InputComponent');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function checklistFixture(rows) {
  const editor=Object.create(Input.prototype);
  const elements=rows.map(row=>({getAttribute:()=>String(row.id),innerHTML:row.data}));
  Object.assign(editor,{checkBoxes:rows,noteToEdit:{checkBoxes:rows},cboxHistory:[],cboxHistoryIndex:-1,
    inputLength:{value:{},next(){}},cd:{detectChanges(){editor.renders++;}},renders:0,saves:0,
    queueAutosave(){editor.saves++;},noteContainer:{nativeElement:{querySelectorAll:()=>elements}}});
  editor.resetCboxHistory();
  return {editor,elements};
}

test('saving large checklists reads row identities linearly and preserves pending DOM text',()=>{
  for(const count of [200,1000]){
    const rows=Array.from({length:count},(_,id)=>({id,data:`Original ${id}`,done:id%2===0,indentLevel:id%3,listId:id<count/2?'first':'second'}));
    const {editor,elements}=checklistFixture(rows);
    elements.reverse();elements[0].innerHTML='<b>Newest unsaved text</b>';
    let identityReads=0;const normalize=editor.normalizeCheckBoxes;
    editor.normalizeCheckBoxes=function(values){return normalize.call(this,values).map(row=>{
      const id=row.id;Object.defineProperty(row,'id',{enumerable:true,get(){identityReads++;return id;}});return row;
    });};
    const result=editor.currentCheckBoxesForSave(false);
    assert.ok(identityReads<=count*2,`reading ${count} rows must not do a search through the list for every element`);
    assert.equal(result.at(-1).data,'<b>Newest unsaved text</b>');assert.equal(rows.at(-1).data,`Original ${count-1}`);
    assert.equal(result[0].done,true);assert.equal(result.at(-1).listId,'second');assert.equal(result.at(-1).indentLevel,(count-1)%3);
    editor.currentCheckBoxesForSave(true);assert.equal(editor.checkBoxes.at(-1).data,'<b>Newest unsaved text</b>');
  }
});

test('indenting preserves nested rows, pending text, completed state and undo/redo',()=>{
  const {editor,elements}=checklistFixture([
    {id:0,data:'Previous',done:false,indentLevel:0},
    {id:1,data:'Parent',done:false,indentLevel:0},
    {id:2,data:'Child',done:true,indentLevel:1},
    {id:3,data:'Next',done:false,indentLevel:0}
  ]);
  elements[1].innerHTML='<i>Unsaved parent edit</i>';
  let reads=0;const read=editor.currentCheckBoxesForSave;
  editor.currentCheckBoxesForSave=function(update){reads++;return read.call(this,update);};
  assert.equal(editor.adjustCboxIndentLevel(1,1),true);
  assert.equal(reads,2,'read the DOM once before indentation and once for history, without a duplicate pre-change scan');
  assert.deepEqual(Array.from(editor.checkBoxes,cb=>cb.indentLevel),[0,1,2,0]);
  assert.equal(editor.checkBoxes[1].data,'<i>Unsaved parent edit</i>');assert.equal(editor.checkBoxes[2].done,true);
  assert.equal(editor.saves,1);assert.equal(editor.renders,1);
  editor.stepCboxHistory('undo');assert.deepEqual(Array.from(editor.checkBoxes,cb=>cb.indentLevel),[0,0,1,0]);
  editor.stepCboxHistory('redo');assert.deepEqual(Array.from(editor.checkBoxes,cb=>cb.indentLevel),[0,1,2,0]);
  assert.equal(editor.checkBoxes[1].data,'<i>Unsaved parent edit</i>');
});

test('indent limits and separate checklist boundaries remain intact; drag previews do not autosave',()=>{
  const {editor}=checklistFixture([
    {id:0,data:'First list',listId:'first',indentLevel:0},
    {id:1,data:'Second list',listId:'second',indentLevel:0},
    {id:2,data:'Parent',listId:'second',indentLevel:0},
    {id:3,data:'Child',listId:'second',indentLevel:1}
  ]);
  assert.equal(editor.adjustCboxIndentLevel(0,1),false);
  assert.equal(editor.adjustCboxIndentLevel(1,1),false);
  assert.equal(editor.setCboxIndentLevel(2,99,{commit:false}),true);
  assert.deepEqual(Array.from(editor.checkBoxes,cb=>cb.indentLevel),[0,0,1,2]);
  assert.equal(editor.saves,0);assert.equal(editor.cboxHistory.length,1);
  assert.equal(editor.setCboxIndentLevel(2,1,{commit:false}),false);
  assert.equal(editor.setCboxIndentLevel(999,1),false);
});

test('overlapping cache notifications coalesce and never publish an older library over newer edits', async () => {
  const gate=deferred(),publications=[];let reads=0;
  const service=Object.create(Notes.prototype);
  Object.assign(service,{cachedNotesPublishVersion:0,offlineSync:{partition:'server',generation:'one'},
    offlineStore:{listNotes:async()=>++reads===1?gate.promise:[{id:1,noteTitle:'Newest',sortOrder:1}]},
    hydrateOfflineNoteMedia:async note=>note,withOptimisticNotes:notes=>notes,publishNotes:notes=>publications.push(notes)});
  const first=service.publishCachedNotes('');
  const second=service.publishCachedNotes('');
  const third=service.publishCachedNotes('');
  gate.resolve([{id:1,noteTitle:'Old read'}]);
  await Promise.all([first,second,third]);
  assert.equal(reads,2);assert.equal(publications.length,1);assert.equal(publications[0][0].noteTitle,'Newest');
});

test('an account switch during cache hydration never publishes the previous account', async () => {
  const gate=deferred(),started=deferred(),publications=[];
  const service=Object.create(Notes.prototype);
  Object.assign(service,{cachedNotesPublishVersion:0,offlineSync:{partition:'old',generation:'one'},
    offlineStore:{listNotes:async partition=>[{id:1,noteTitle:partition}]},
    hydrateOfflineNoteMedia:async note=>{if(note.noteTitle==='old'){started.resolve();await gate.promise;}return note;},
    withOptimisticNotes:notes=>notes,publishNotes:notes=>publications.push(notes)});
  const old=service.publishCachedNotes('');await started.promise;
  service.offlineSync.partition='new';service.offlineSync.generation='two';
  const next=service.publishCachedNotes('');gate.resolve();await Promise.all([old,next]);
  assert.equal(publications.length,1);assert.equal(publications[0][0].noteTitle,'new');
});

test('a cache notification at the end of a publication is not lost while its promise settles',async()=>{
  let reads=0;const publications=[];
  const service=Object.create(Notes.prototype);
  Object.assign(service,{cachedNotesPublishVersion:0,offlineSync:{partition:'server',generation:'one'},
    offlineStore:{listNotes:async()=>[{id:1,noteTitle:`Read ${++reads}`}]},
    hydrateOfflineNoteMedia:async note=>note,withOptimisticNotes:notes=>notes,
    publishNotes:notes=>{publications.push(notes);if(publications.length===1)queueMicrotask(()=>service.publishCachedNotes(''));}});
  await service.publishCachedNotes('');
  assert.equal(publications.length,2);assert.equal(publications[1][0].noteTitle,'Read 2');
});

async function fixture(local = false) {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('note-save');
  if (local) { workspace.mode = 'local'; await store.saveWorkspace(workspace); }
  const original = await store.commitMutation(workspace, 'note.upsert', 'saved-note', { id: 42, noteTitle: 'Title', noteBody: 'Before', images: [], labels: [] });
  const service = Object.create(Notes.prototype);
  Object.assign(service, { offlineStore: store, offlineSync: { writesLocally: true, partition: workspace.partition, generation: workspace.generation,
    commit: (type, syncId, note) => store.commitMutation(workspace, type, syncId, note) },
    cachedOrLoadedNote: async () => original, canonicalizeNoteMedia: note => note,
    localReminderRefreshQueue: Promise.resolve(), mergeNoteIntoList: note => { service.published = note; },
    load: () => assert.fail('commit already requests a cache refresh; do not hydrate the whole library again') });
  const editor = Object.create(Input.prototype);
  const ref = extra => ({ nativeElement: { innerHTML: '', style: {}, dataset: {}, ...extra } });
  Object.assign(editor, { isEditing: true, noteToEdit: original, destroyed: false, editorGeneration: 0, saveQueue: Promise.resolve(),
    noteTitle: ref({ innerHTML: 'Title edited' }), noteMain: ref({ style: { backgroundColor: '' } }),
    notePin: ref({ dataset: { pinned: 'false' } }), cboxInput: ref({ blur() {} }),
    labelsForSave: async () => [], isDrawingNote: false, isCbox: { value: false },
    currentCheckBoxesForSave: () => [], editorBodyHtml: () => '<p>Final mobile edit</p>',
    images: [], attachments: [], pendingAttachmentFiles: [], selectedCollaboratorIds: [],
    hasMeaningfulBody: value => !!value, noteChangedForSave: () => true, noteSaveSnapshot: JSON.stringify,
    notesService: service, auth: { canonicalImageUrl: value => value, isAuthExpiredError: () => false },
    uploadPendingAttachments: async () => {}, flushPendingReminderSaves() {}, updateLastEditedTime() {},
    Shared: { closeModal: { next: () => { editor.closed = true; } } },
    showNoteSaveError: () => { editor.errorShown = true; } });
  return { store, workspace, service, editor };
}

for (const local of [false, true]) test(`mobile Back closes after durable save without waiting for reminders (${local ? 'device-only' : 'server'})`, async () => {
  const { store, workspace, service, editor } = await fixture(local);
  const commitGate = deferred(), reminderGate = deferred(), reminderStarted = deferred();
  const commit = service.offlineSync.commit;
  service.offlineSync.commit = async (...args) => { await commitGate.promise; return commit(...args); };
  service.reminders = { refreshNoteContent: async () => { reminderStarted.resolve(); await reminderGate.promise; } };
  editor.mobileBack();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.closed, undefined, 'never close before the local transaction commits');
  commitGate.resolve();
  await editor.saveQueue;
  await reminderStarted.promise;
  assert.equal(editor.closed, true, 'reminder/native follow-up must not hold the editor open');
  assert.equal(service.published.noteBody, '<p>Final mobile edit</p>', 'overview receives the saved edit immediately');
  assert.equal((await store.getNote(workspace.partition, 42)).noteBody, '<p>Final mobile edit</p>');
  if (!local) assert.ok((await store.listOutbox(workspace.partition)).some(entry => entry.payload.noteBody === '<p>Final mobile edit</p>'));
  reminderGate.resolve();
  await service.localReminderRefreshQueue;
});

test('a new local-first note publishes after its commit without waiting for a library reload', async () => {
  const { store, workspace, service } = await fixture();
  service.prependNotesIntoList = notes => { service.published = notes[0]; };
  const id = await service.add({ syncId: 'fresh-note', noteTitle: 'New mobile note', noteBody: 'Saved before Back', bgColor: '' });
  assert.equal(service.published.id, id);
  assert.equal((await store.getNote(workspace.partition, id)).noteBody, 'Saved before Back');
  assert.ok((await store.listOutbox(workspace.partition)).some(entry => entry.syncId === 'fresh-note'));
});

test('failed local storage keeps the editor open and reports the save failure', async () => {
  const { store, workspace, service, editor } = await fixture();
  service.offlineSync.commit = async () => { throw new Error('Storage failed'); };
  service.reminders = { refreshNoteContent: () => assert.fail('no reminders after a failed save') };
  editor.mobileBack();
  assert.equal(await editor.saveQueue, false);
  assert.equal(editor.closed, undefined);
  assert.equal(editor.errorShown, true);
  assert.equal((await store.getNote(workspace.partition, 42)).noteBody, 'Before');
});

test('rapid saves keep reminder follow-up ordered and use the latest committed content', async () => {
  const { service, editor } = await fixture();
  const gate = deferred(), started = deferred();
  const bodies = [];
  service.reminders = { refreshNoteContent: async note => { bodies.push(note.noteBody); if (bodies.length === 1) { started.resolve(); await gate.promise; } } };
  await editor.saveNote(false);
  await started.promise;
  editor.editorBodyHtml = () => 'Second edit';
  await editor.saveNote(false);
  editor.editorBodyHtml = () => 'Latest edit';
  editor.mobileBack();
  await editor.saveQueue;
  assert.equal(editor.closed, true);
  gate.resolve();
  await service.localReminderRefreshQueue;
  assert.equal(bodies.at(-1), 'Latest edit');
  assert.ok(bodies.slice(1).every(body => body === 'Latest edit'), 'pending refreshes never replay older saved text');
});

test('queued reminder work does not cross a workspace generation change', async () => {
  const { service, editor } = await fixture();
  const gate = deferred();
  service.localReminderRefreshQueue = gate.promise;
  service.reminders = { refreshNoteContent: () => assert.fail('old workspace work must not touch the new account') };
  editor.mobileBack();
  await editor.saveQueue;
  service.offlineSync.generation = 'different-workspace-generation';
  gate.resolve();
  await service.localReminderRefreshQueue;
});


test('workspace generation becoming ready during hydration retries without requiring another notification', async () => {
  const service=Object.create(Notes.prototype), publications=[];
  let reads=0;
  Object.assign(service,{cachedNotesPublishVersion:0,offlineSync:{partition:'server',generation:undefined},
    offlineStore:{listNotes:async()=>{reads++;return [{id:1,noteTitle:'Cached note'}];}},
    hydrateOfflineNoteMedia:async note=>{service.offlineSync.generation='ready-generation';return note;},
    withOptimisticNotes:notes=>notes,publishNotes:notes=>publications.push(notes)});
  await service.publishCachedNotes('');
  assert.equal(reads,2);assert.equal(publications.length,1);assert.equal(publications[0][0].noteTitle,'Cached note');
});

test('targeted cache refresh hydrates one changed note and preserves the other 999 notes',async()=>{
  const service=Object.create(Notes.prototype),records=new Map();let fullReads=0,hydrates=0;const reads=[];
  for(let i=0;i<1000;i++)records.set(`cached-${i}`,{id:i+1,syncId:`cached-${i}`,noteTitle:`Note ${i}`,pinned:false,sortOrder:i});
  Object.assign(service,{cachedNotesPublishVersion:0,offlineSync:{partition:'server',generation:'one',writesLocally:true},notesList$:{value:null},
    offlineStore:{listNotes:async()=>{fullReads++;return [...records.values()];},getNotesBySyncIds:async(_partition,ids)=>{reads.push([...ids]);return ids.map(id=>records.get(id)).filter(Boolean);}},
    hydrateOfflineNoteMedia:async note=>{hydrates++;return {...note};},withOptimisticNotes:notes=>notes,publishNotes:notes=>service.notesList$.value=notes});
  await service.publishCachedNotes('');const untouched=service.notesList$.value.find(note=>note.id===2);hydrates=0;
  records.set('cached-0',{...records.get('cached-0'),noteTitle:'Edited',pinned:true});
  await service.publishCachedNotes('',{noteSyncIds:['cached-0']});
  assert.equal(fullReads,1);assert.equal(hydrates,1);assert.equal(service.notesList$.value.length,1000);
  assert.equal(service.notesList$.value[0].noteTitle,'Edited');assert.equal(service.notesList$.value.find(note=>note.id===2),untouched);
  records.delete('cached-0');await service.publishCachedNotes('',{noteSyncIds:['cached-0']});
  assert.equal(service.notesList$.value.length,999);assert.equal(fullReads,1);
  records.set('new',{id:2000,syncId:'new',noteTitle:'New note',pinned:false,sortOrder:2000});
  await service.publishCachedNotes('',{noteSyncIds:['new']});assert.equal(service.notesList$.value[0].id,2000);assert.equal(fullReads,1);
  await service.publishCachedNotes('');assert.equal(fullReads,2,'unknown/catalogue changes still refresh the complete cache');
});

test('overlapping targeted refreshes retain every changed identity, including deletes and canonical new-note IDs',async()=>{
  const service=Object.create(Notes.prototype),gate=deferred(),started=deferred();let paused=false,fullReads=0;
  const records=new Map([['one',{id:-1,syncId:'one',noteTitle:'Draft'}],['two',{id:2,syncId:'two',noteTitle:'Old'}]]);
  Object.assign(service,{cachedNotesPublishVersion:0,offlineSync:{partition:'server',generation:'one',writesLocally:true},notesList$:{value:null},
    offlineStore:{listNotes:async()=>{fullReads++;return [...records.values()];},getNotesBySyncIds:async(_partition,ids)=>ids.map(id=>records.get(id)).filter(Boolean)},
    hydrateOfflineNoteMedia:async note=>{if(paused){paused=false;started.resolve();await gate.promise;}return note;},withOptimisticNotes:notes=>notes,publishNotes:notes=>service.notesList$.value=notes});
  await service.publishCachedNotes('');paused=true;
  const first=service.publishCachedNotes('',{noteSyncIds:['one']});await started.promise;
  records.set('one',{id:1,syncId:'one',noteTitle:'Canonical'});records.delete('two');
  const second=service.publishCachedNotes('',{noteSyncIds:['two']});gate.resolve();await Promise.all([first,second]);
  assert.equal(fullReads,1);assert.equal(service.notesList$.value.length,1);assert.equal(service.notesList$.value[0].id,1);assert.equal(service.notesList$.value[0].noteTitle,'Canonical');
});

test('a cached launch resolves its workspace generation before the first read, avoiding a full reload on the next edit',async()=>{
 const service=Object.create(Notes.prototype);let reads=0,ready=false;
 const sync={partition:'server',generation:'',writesLocally:true,workspace:async()=>{ready=true;sync.generation='ready';}};
 Object.assign(service,{cachedNotesPublishVersion:0,offlineSync:sync,notesList$:{value:null},
  offlineStore:{listNotes:async()=>{assert.equal(ready,true);reads++;return [{id:1,syncId:'one',pinned:false,noteTitle:'Initial'}];},getNotesBySyncIds:async()=>[{id:1,syncId:'one',pinned:false,noteTitle:'Edited'}]},
  hydrateOfflineNoteMedia:async note=>note,withOptimisticNotes:notes=>notes,publishNotes:notes=>service.notesList$.value=notes});
 await service.publishCachedNotes('');await service.publishCachedNotes('',{noteSyncIds:['one']});
 assert.equal(reads,1);assert.equal(service.notesList$.value[0].noteTitle,'Edited');
});

test('position-only overview updates keep hydrated images and skip media preparation',async()=>{
  const service=Object.create(Notes.prototype);
  const first={id:1,syncId:'one',sortOrder:10,noteBody:'<img src="blob:already-ready">',images:[{dataUrl:'blob:already-ready'}]};
  const second={id:2,syncId:'two',sortOrder:9,noteBody:'Other content'};
  const state={value:[first,second]};let hydrations=0;
  Object.assign(service,{notesList$:state,cachedNotesPublishVersion:0,cachedLibraryIdentity:'server:one',
    offlineSync:{partition:'server',generation:'one',writesLocally:true},
    offlineStore:{getNotesBySyncIds:async()=>[{...first,sortOrder:8,noteBody:'<img src="/uploads/canonical.jpg">'}]},
    hydrateOfflineNoteMedia:async note=>{hydrations++;return note;},withOptimisticNotes:notes=>notes,publishNotes:notes=>{state.value=notes;}});
  await service.publishCachedNotes('',{noteSyncIds:['one'],positionsOnly:true});
  assert.equal(hydrations,0);assert.equal(state.value[0],second);
  assert.equal(state.value[1].noteBody,first.noteBody);assert.equal(state.value[1].images,first.images);assert.equal(state.value[1].sortOrder,8);
  await service.publishCachedNotes('',{noteSyncIds:['one']});
  assert.equal(hydrations,1,'a real content update still prepares its changed media');
});
