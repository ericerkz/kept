const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');
const { Subject, debounceTime } = require('rxjs');

const source = readFileSync('src/app/components/input/input.component.ts', 'utf8');
function method(name) {
  const match = new RegExp(`^  (?:private )?(?:async )?${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing method ${name}`);
  return source.slice(match.index, source.indexOf('\n  }', match.index) + 4);
}
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(`class Editor {
  ${method('newDrawing')}
}
globalThis.Editor = Editor;`), context);

function editor(save) {
  const events = [];
  const instance = new context.Editor();
  Object.assign(instance, {
    showDrawingMoreMenu: true,
    saveNote: async (...args) => { events.push(['save', ...args]); return save(); },
    Shared: { drawingNoteRequested: { next: () => events.push(['open']) } },
    clearDrawingCanvas: () => events.push(['clear']),
    queueAutosave: () => events.push(['autosave'])
  });
  return { instance, events };
}

test('New waits for persistence, then requests a separate drawing without clearing current pixels', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { instance, events } = editor(() => pending);
  const result = instance.newDrawing();
  assert.deepEqual(events, [['save']]);
  finish();
  await result;
  assert.deepEqual(events, [['save'], ['open']]);
  assert.equal(instance.showDrawingMoreMenu, false);
});

test('failed persistence leaves the current drawing accessible and does not request another note', async () => {
  const { instance, events } = editor(() => false);
  await instance.newDrawing();
  assert.deepEqual(events, [['save']]);
});

test('repeated New clicks while saving do not create multiple composers', async () => {
  let finish;
  const { instance, events } = editor(() => new Promise(resolve => { finish = resolve; }));
  const first = instance.newDrawing();
  await instance.newDrawing();
  assert.deepEqual(events, [['save']]);
  finish();
  await first;
  assert.deepEqual(events, [['save'], ['open']]);
});

test('a closed draft autosave cannot save the fresh composer, but fresh edits still autosave', async () => {
  const start = source.indexOf('    this.autoSaveSubscription =', source.indexOf('  ngAfterViewInit()'));
  const setup = source.slice(start, source.indexOf("    document.addEventListener('visibilitychange'", start));
  const timers = vm.createContext({ debounceTime });
  vm.runInContext(stripTypeScriptTypes(`class Autosave {
    ${method('queueAutosave')}
    start() { ${setup} }
  }
  globalThis.Autosave = Autosave;`), timers);
  const instance = new timers.Autosave();
  let saves = 0;
  Object.assign(instance, {
    autoSaveSubject: new Subject(), editorGeneration: 0,
    noteMain: { nativeElement: { hidden: false } },
    flushAutosave: () => { saves++; }
  });
  instance.start();
  try {
    instance.queueAutosave();
    instance.editorGeneration++;
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(saves, 0);
    instance.queueAutosave();
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(saves, 1);
  } finally {
    instance.autoSaveSubscription.unsubscribe();
  }
});

for (const [platform, phone] of [['web', false], ['web', true], ['ios', false], ['android', false]]) {
  test(`${platform} ${phone ? 'phone' : 'wide'} quick-create uses the appropriate composer and acknowledges it`, async () => {
    const calls = [];
    const sandbox = vm.createContext({
      console,
      Capacitor: { getPlatform: () => platform },
      shouldUseFullscreenNoteEditor: () => phone,
      requestAnimationFrame: callback => callback(),
      document: { querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 80 }) }) },
      window: { scrollY: 300, scrollTo: value => calls.push(['scroll', value.top]) }
    });
    vm.runInContext(stripTypeScriptTypes(`class Composer { ${method('openWidgetComposer')} } globalThis.Composer = Composer;`), sandbox);
    const instance = new sandbox.Composer();
    const request = { requestId: 'new-drawing', type: 'drawing' };
    Object.assign(instance, {
      isEditing: false, isDrawingNote: false, isCbox: { value: false }, mobileComposeMode: false,
      noteMain: { nativeElement: { hidden: true } },
      main: { nativeElement: { getBoundingClientRect: () => ({ top: -200 }) } },
      notePhClick() { this.noteMain.nativeElement.hidden = false; calls.push(['inline']); },
      openMobileComposer() { this.noteMain.nativeElement.hidden = false; this.mobileComposeMode = true; calls.push(['fullscreen']); },
      startMobileDrawing() { this.isDrawingNote = true; }, cd: { detectChanges() {} },
      Shared: { widgetComposerOpened: { next: value => calls.push(['ack', value.requestId]) } }
    });
    await instance.openWidgetComposer(request);
    const desktop = platform === 'web' && !phone;
    assert.equal(instance.mobileComposeMode, !desktop);
    assert.deepEqual(calls[0], [desktop ? 'inline' : 'fullscreen']);
    assert.equal(calls.filter(call => call[0] === 'scroll').length, desktop ? 1 : 0);
    assert.deepEqual(calls.at(-1), ['ack', request.requestId]);
  });
}
