const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Subject, BehaviorSubject } = require('rxjs');

const source = ts.transpileModule(fs.readFileSync('src/app/components/sidenav/sidenav.component.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

function open({ storage = new Map(), phone = false, width = 820, blocked = false } = {}) {
  const exports = {}, classes = new Set();
  const sidebar = { classList: {
    contains: name => classes.has(name), add: name => classes.add(name),
    toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; }
  } };
  vm.runInNewContext(source, {
    exports, document: { querySelector: () => sidebar }, window: { innerWidth: width }, setTimeout: callback => callback(),
    localStorage: {
      getItem(key) { if (blocked) throw Error('Storage unavailable'); return storage.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw Error('Storage unavailable'); storage.set(key, value); }
    },
    require(name) {
      if (name === '@angular/core') return { Component: () => value => value, ViewChild: () => () => {} };
      if (name.endsWith('/platform')) return { isNativePhonePlatform: () => phone };
      return {};
    }
  });
  const shared = { initPwa() {}, closeSideBar: new Subject(), closeSideBarIfOpen: new Subject(), sideBarCollapsed: new BehaviorSubject(false) };
  const component = new exports.NavComponent(shared, {}, { currentUser: { id: 1 } });
  component.ngOnInit();
  return { component, shared, sidebar };
}

test('docked sidebar restores either deliberate state after navigation or reopening', () => {
  const storage = new Map();
  const first = open({ storage });
  assert.equal(first.shared.sideBarCollapsed.value, false);
  first.component.collapseSideBar();first.component.ngOnDestroy();
  const reopened = open({ storage });
  assert.equal(reopened.shared.sideBarCollapsed.value, true);
  assert.equal(reopened.sidebar.classList.contains('close'), true);
  reopened.component.collapseSideBar();reopened.component.ngOnDestroy();
  assert.equal(open({ storage }).shared.sideBarCollapsed.value, false);
});

test('transient phone drawers always start closed and preserve the docked preference', () => {
  for (const options of [{ phone: true, width: 900 }, { width: 390 }]) {
    const storage = new Map([['kept_sidebar_collapsed', 'false']]);
    const drawer = open({ storage, ...options });
    assert.equal(drawer.shared.sideBarCollapsed.value, true);
    drawer.component.collapseSideBar();assert.equal(drawer.component.isMobileOpen, true);
    drawer.component.onNavItemClick();assert.equal(drawer.component.isMobileOpen, false);
    assert.equal(storage.get('kept_sidebar_collapsed'), 'false');
    assert.equal(open({ storage }).shared.sideBarCollapsed.value, false);
  }
});

test('unavailable storage leaves sidebar controls working', () => {
  const sidebar = open({ blocked: true });
  sidebar.component.collapseSideBar();assert.equal(sidebar.shared.sideBarCollapsed.value, true);
  sidebar.component.collapseSideBar();assert.equal(sidebar.shared.sideBarCollapsed.value, false);
});


test('sharing previews ignore stale requests and a previous account while retaining current avatars', async () => {
  const { component }=open();
  const pending=[];
  component.binders={sync:{partition:'server:first'},sharingPreviews:()=>new Promise(resolve=>pending.push(resolve))};
  const old=component.refreshSharingPreviews();
  component.binders.sync.partition='server:second';
  assert.equal(component.binderPreview('Family'),undefined);
  const current=component.refreshSharingPreviews();
  const members=[{id:7,avatarPreset:'panda'}];
  pending[1](new Map([['family',members]]));await current;
  pending[0](new Map([['family',[{id:99,avatarDataUrl:'old-account-photo'}]]]));await old;
  assert.equal(component.binderPreview('Family'),members);
  const closing=component.refreshSharingPreviews();component.ngOnDestroy();
  pending[2](new Map([['family',[{id:88}]]]));await closing;
  assert.equal(component.binderPreview('Family'),members);
});

test('binder drag handles retain keyboard ordering and focus without visible arrow buttons', async () => {
  const { component,shared }=open();let focused=false;
  shared.binder={list:[{name:'First'},{name:'Second'}],db:{reorder:async names=>{shared.binder.list=names.map(name=>({name}));}}};
  const button={disabled:false,isConnected:true,focus:()=>{focused=true;}};
  let prevented=false;
  component.onBinderReorderKeydown({key:'ArrowUp',currentTarget:button,preventDefault:()=>{prevented=true;},stopPropagation(){}},'Second');
  await new Promise(setImmediate);
  assert.deepEqual(shared.binder.list.map(item=>item.name),['Second','First']);
  assert.equal(prevented,true);assert.equal(focused,true);
});


test('label drag handles preserve keyboard reordering and counts never cross workspace boundaries',async()=>{
  const {component,shared}=open();let focused=false;
  shared.label={list:[{id:1,name:'First'},{id:2,name:'Second'}],db:{reorder:async labels=>{shared.label.list=labels;},noteCounts:async()=>({First:4,Second:0})}};
  component.binders={sync:{partition:'local:labels'}};
  await component.refreshLabelCounts();
  assert.equal(component.labelNoteCount('First'),4);assert.equal(component.labelNoteCount('Second'),0);
  const button={disabled:false,isConnected:true,focus:()=>{focused=true;}};
  component.onLabelReorderKeydown({key:'ArrowUp',currentTarget:button,preventDefault(){},stopPropagation(){}},2);
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(shared.label.list,label=>label.name),['Second','First']);assert.equal(focused,true);
  component.binders.sync.partition='local:other';
  assert.equal(component.labelNoteCount('First'),undefined);
});
