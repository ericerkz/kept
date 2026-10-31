const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function harness({ width = 390, cardWidth = 310, saveFails = false } = {}) {
  const calls = { saves: [], undo: [], opens: 0, drags: 0, binderDrags: 0, errors: [] };
  const timers = new Map(); let now = 1000, timerId = 0;
  class Clock extends Date { static now() { return now; } }
  const timeout = (callback, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; };
  const clear = id => timers.delete(id);
  const tick = duration => {
    const end = now + duration;
    while ([...timers.values()].some(timer => timer.at <= end)) {
      const [id, timer] = [...timers].filter(([,timer]) => timer.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
      timers.delete(id); now = timer.at; timer.callback();
    }
    now = end;
  };
  const surface = { animations: [], getAnimations: () => [], animate(...args) { this.animations.push(args); } };
  const classes = new Set(), styles = new Map();
  const card = { isConnected: true, closest: () => null, getBoundingClientRect: () => ({width:cardWidth}),
    querySelector: () => surface,
    classList: {add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),
      toggle:(name,on)=>on ? classes.add(name) : classes.delete(name)},
    style:{setProperty:(name,value)=>styles.set(name,value),removeProperty:name=>styles.delete(name)} };
  const listeners = new Map();
  const events = scope => ({
    addEventListener(name, callback) { listeners.set(`${scope}:${name}`,callback); },
    removeEventListener(name, callback) { if (listeners.get(`${scope}:${name}`) === callback) listeners.delete(`${scope}:${name}`); }
  });
  const document = { ...events('document'), visibilityState:'visible', querySelector:()=>null };
  const window = { ...events('window'), innerWidth:width, innerHeight:800, scrollY:0, matchMedia:()=>({matches:false}) };
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync('src/app/components/notes/notes.component.ts','utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}
  }).outputText;
  vm.runInNewContext(source, {exports,console,document,window,Date:Clock,setTimeout:timeout,clearTimeout:clear,
    require(name) {
      if (name === '@angular/core') return {Component:()=>value=>value,ViewChild:()=>()=>{},ViewChildren:()=>()=>{},HostListener:()=>()=>{}};
      if (name.endsWith('/platform')) return {isNativePhonePlatform:()=>width<768};
      if (name === '@capacitor/core') return {registerPlugin:()=>({}),Capacitor:{getPlatform:()=> 'web'}};
      return {};
    }
  });
  const note = {id:1,ownerUserId:7,pinned:false,archived:false,trashed:false};
  const Shared = { selectedNoteIds:{value:[]}, searchQuery:'', note:{all:[note],pinned:[],unpinned:[note]}, snackBar:(...args)=>calls.undo.push(args) };
  const notesService = {async updateKey(patch,id) {calls.saves.push({id,patch});if(saveFails)throw Error('Storage failure');}};
  const zone = {run:callback=>callback(),runOutsideAngular:callback=>callback()};
  const component = new exports.NotesComponent(Shared,{}, {isLocal:false,currentUser:{id:7}}, {},zone,notesService,{}, {}, {}, {}, {}, {}, {});
  component.modalContainer={nativeElement:{style:{display:'none'}}};
  component.openModal=()=>{calls.opens++;};
  component.showMessage=message=>calls.errors.push(message);
  component.beginTouchDrag=note=>{calls.drags++;component.touchDragNote=note;};
  component.endTouchDrag=()=>{component.touchDragNote=null;};
  component.beginBinderDrop=()=>{calls.binderDrags++;};
  const touch = (x,y=200,id=1) => ({clientX:x,clientY:y,identifier:id});
  const event = (point,{end=false,count=1,target=card,cancelable=true}={}) => ({
    target,currentTarget:card,cancelable,touches:end?[]:Array.from({length:count},(_,i)=>({...point,identifier:i+1})),
    changedTouches:[point], prevented:false,preventDefault(){this.prevented=true;}
  });
  const start=(x=120,y=200,options)=>component.onTouchStart(note,event(touch(x,y),options));
  const move=(x,y=200,options)=>{
    const value=event(touch(x,y),options);
    component.onTouchMove(value);
    listeners.get('document:touchmove')?.(value);
    return value;
  };
  const end=(x,y=200,options)=>component.onTouchEnd(card,note,event(touch(x,y),{end:true,...options}));
  return {component,note,card,surface,classes,styles,document,window,listeners,calls,tick,start,move,end,event,touch};
}
const settle = () => new Promise(resolve=>setImmediate(resolve));

for (const direction of [-1,1]) test(`a deliberate ${direction < 0 ? 'left' : 'right'} touch swipe archives once and offers Undo`,async()=>{
  const h=harness();h.start(direction<0?250:100);const moved=h.move(direction<0?120:230);
  assert.equal(moved.prevented,true);assert.ok(h.classes.has('note-swipe-ready'));
  h.end(direction<0?120:230);await settle();
  assert.equal(h.calls.saves.length,1);assert.equal(h.calls.saves[0].patch.archived,true);
  assert.equal(h.calls.undo[0][1].archived,false);assert.equal(h.calls.opens,0);assert.equal(h.calls.binderDrags,0);
  assert.equal(h.listeners.size,0);assert.equal(h.classes.size,0);assert.equal(h.styles.size,0);
});

test('short swipes snap back; ordinary taps still open notes',()=>{
  const h=harness();h.start();h.move(150);h.end(150);
  assert.equal(h.calls.saves.length,0);assert.equal(h.calls.opens,0);assert.equal(h.surface.animations.length,1);
  h.tick(400);h.start();h.end(120);assert.equal(h.calls.opens,1);
});

test('a claimed swipe still commits when touchend is not cancelable',async()=>{
  const h=harness();h.start();h.move(260);h.end(260,200,{cancelable:false});await settle();
  assert.equal(h.calls.saves.length,1);assert.equal(h.calls.opens,0);
});

test('vertical and diagonal scrolling never become archive swipes later in the same touch',()=>{
  for(const point of [[125,235],[145,220]]){
    const h=harness();h.start();assert.equal(h.move(...point).prevented,false);
    h.move(300,240);h.end(300,240);h.tick(500);
    assert.equal(h.calls.saves.length,0);assert.equal(h.calls.drags,0);assert.equal(h.calls.opens,0);
  }
});

test('a 400ms hold reserves the touch for selection/reordering and binder dragging',()=>{
  const h=harness();h.start();h.tick(400);assert.equal(h.calls.drags,1);assert.equal(h.listeners.size,0);
  h.move(300);h.end(300);assert.equal(h.calls.saves.length,0);
});

test('swiping prevents pull-to-refresh from claiming a curved horizontal gesture',()=>{
  const h=harness();h.start();h.component.onPullRefreshTouchStart(h.event(h.touch(120)));
  h.move(150,205);assert.equal(h.component.pullRefreshTracking,false);
  h.component.onPullRefreshTouchMove(h.event(h.touch(260,230)));
  assert.equal(h.component.pullRefreshActive,false);h.end(260,230);
});

test('controls, selection, edge starts, archived/trash notes, and received shared notes never archive',()=>{
  const cases = [h=>{h.component.Shared.selectedNoteIds.value=[1];},h=>{h.note.archived=true;},
    h=>{h.note.trashed=true;},h=>{h.note.ownerUserId=8;},h=>{h.document.querySelector=()=>({});},
    h=>{h.component.modalContainer.nativeElement.style.display='block';}];
  for(const setup of cases){const h=harness();setup(h);h.start();h.move(280);h.end(280);assert.equal(h.calls.saves.length,0);}
  for(const x of [10,380]){const h=harness();h.start(x);h.move(x<100?180:200);h.end(x<100?180:200);assert.equal(h.calls.saves.length,0);}
  const h=harness();h.start(120,200,{target:{closest:()=>({})}});h.move(300);h.end(300);h.tick(500);
  assert.equal(h.calls.saves.length,0);assert.equal(h.calls.drags,0);
});

test('multitouch, cancellation, resize, focus loss, and browser-owned gestures abort safely',()=>{
  for(const cancel of [h=>h.component.onTouchCancel(),h=>h.listeners.get('window:resize')(),
    h=>h.listeners.get('window:blur')(),h=>{h.document.visibilityState='hidden';h.listeners.get('document:visibilitychange')();},
    h=>h.listeners.get('document:touchstart')(h.event(h.touch(240),{count:2})),h=>h.move(280,200,{cancelable:false})]){
    const h=harness();h.start();h.move(240);cancel(h);h.end(280);assert.equal(h.calls.saves.length,0);
    assert.equal(h.listeners.size,0);assert.equal(h.classes.size,0);
  }
});

test('touch swipes work at foldable/desktop widths; mouse drag keeps its existing path',async()=>{
  for(const width of [1000,1280]){const h=harness({width});h.start();h.move(260);h.end(260);await settle();assert.equal(h.calls.saves.length,1);}
  const h=harness();h.component.noteDragStart(h.note,{preventDefault(){throw Error('Mouse drag should remain available');},dataTransfer:{setData(){}}});
  assert.equal(h.calls.binderDrags,1);assert.equal(h.component.draggedNoteId,1);assert.equal(h.calls.saves.length,0);
});

test('a failed save restores the card and does not announce a successful archive',async()=>{
  const h=harness({saveFails:true});h.start();h.move(260);h.end(260);await settle();
  assert.equal(h.calls.errors.length,1);assert.equal(h.calls.undo.length,0);assert.equal(h.classes.size,0);
});
