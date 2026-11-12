const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), rx = require('rxjs');

const source = ts.transpileModule(fs.readFileSync('src/app/components/notes/notes.component.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

function harness(platform, available = true) {
  const exports = {}, events = [], workspace = { id: 'device', generation: 'first' };
  let pending = { type: 'plain', workspaceId: workspace.id, generation: workspace.generation };
  const plugin = {
    async getPendingCreateType() { events.push('read-create'); return pending; },
    async getPendingOpenNoteId() { events.push('read-note'); return { ...pending, noteId: 42 }; },
    async acknowledgeCreateType() { events.push('ack-create'); },
    async acknowledgeOpenNoteId() { events.push('ack-note'); }
  };
  vm.runInNewContext(source, { exports, console, setTimeout, clearTimeout, require(name) {
    if (name === '@angular/core') return { Component: () => value => value,
      ViewChild: () => () => {}, ViewChildren: () => () => {}, HostListener: () => () => {} };
    if (name === '@capacitor/core') return {
      Capacitor: { getPlatform: () => platform, isPluginAvailable: name => available && name === 'KeptWidgetIntents' },
      registerPlugin: name => name === 'KeptWidgetIntents' ? plugin : {}
    };
    if (name === 'rxjs') return rx;
    return {};
  } });
  const component = Object.create(exports.NotesComponent.prototype);
  Object.assign(component, {
    pendingWidgetOpenInFlight: false,
    auth: { isLocal: true }, offlineSync: { workspace: async () => workspace },
    Shared: { clearNoteSelection() { events.push('clear-selection'); }, widgetCreateRequested: new rx.Subject(), widgetComposerOpened: new rx.Subject() },
    modalContainer: { nativeElement: { style: { display: 'none' } } },
    notesService: { async get(id) { events.push(`get-note:${id}`); return { id }; } },
    async openModal(_element, note) { events.push(`open-note:${note.id}`); }
  });
  component.Shared.widgetCreateRequested.subscribe(request => {
    events.push(`open-create:${request.type}`);
    component.Shared.widgetComposerOpened.next(request);
  });
  return { component, events, setPending(value) { pending = value; } };
}

for (const platform of ['ios', 'android']) {
  for (const type of ['plain', 'checklist', 'drawing']) test(`${platform}: widget ${type} creates a note before acknowledging the request`, async () => {
    const h = harness(platform); h.setPending({ type, workspaceId: 'device', generation: 'first' });
    await h.component.openPendingWidgetNote();
    assert.deepEqual(h.events, ['read-create', 'clear-selection', `open-create:${type}`, 'ack-create']);
  });
  test(`${platform}: pending note opens before acknowledgement`, async () => {
    const h = harness(platform); h.setPending({ type: null, workspaceId: 'device', generation: 'first' });
    await h.component.openPendingWidgetNote();
    assert.deepEqual(h.events, ['read-create', 'read-note', 'clear-selection', 'get-note:42', 'open-note:42', 'ack-note']);
  });
}
test('a browser or older native app without the plugin does not read pending widget intents', async () => {
  for (const platform of ['web', 'ios', 'android']) {
    const h = harness(platform, false); await h.component.openPendingWidgetNote(); assert.deepEqual(h.events, []);
  }
});
test('widget intents from another workspace generation are neither acted on nor acknowledged', async () => {
  const h = harness('ios'); h.setPending({ type: 'plain', workspaceId: 'device', generation: 'old' });
  await h.component.openPendingWidgetNote(); assert.deepEqual(h.events, ['read-create', 'read-note']);
});
test('overlapping startup and resume checks consume one widget request', async () => {
  const h = harness('ios'); let release;
  h.component.waitForAuth = () => new Promise(resolve => { release = resolve; });
  const first = h.component.openPendingWidgetNote(); await h.component.openPendingWidgetNote();
  h.component.waitForAuth = async () => {}; release(); await first;
  assert.equal(h.events.filter(event => event === 'ack-create').length, 1);
});
