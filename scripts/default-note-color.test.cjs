const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { BehaviorSubject } = require('rxjs');
const { createStore } = require('../test-support/workspace-store.cjs');

function preferences(auth) {
  const exports = {};
  const storage = new Map();
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/services/user-preferences.service.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, require(name) {
    if (name === '@angular/core') return { Injectable: () => value => value };
    if (name === 'rxjs') return { BehaviorSubject };
    return {};
  } });
  return new exports.UserPreferencesService(auth);
}

test('changing accounts and local workspaces never carries another default colour across', async () => {
  const auth = { isLocal: false, accessChanges$: new BehaviorSubject({ token: 'one', defaultNoteColor: '#d2e3fc' }), loadAccountPreferences: async () => {} };
  const prefs = preferences(auth);
  assert.equal(prefs.value.defaultNoteColor, '#d2e3fc');
  auth.accessChanges$.next({ token: 'two' });
  assert.equal(prefs.value.defaultNoteColor, '');
  auth.isLocal = true;
  auth.workspace = { local: { id: 'local-one', preferences: { defaultNoteColor: '#e8d7ff' } } };
  auth.accessChanges$.next(null);
  assert.equal(prefs.value.defaultNoteColor, '#e8d7ff');
  auth.workspace.local = { id: 'local-two', preferences: {} };
  auth.accessChanges$.next(null);
  assert.equal(prefs.value.defaultNoteColor, '');
});

test('default colour changes persist through account preferences and roll back on failure', async () => {
  const auth = { isLocal: false, accessChanges$: new BehaviorSubject(null), updateAccountPreferences: async patch => { auth.saved = patch.defaultNoteColor; } };
  const prefs = preferences(auth);
  await prefs.updateDefaultNoteColor('#d2e3fc');
  assert.equal(auth.saved, '#d2e3fc');
  assert.equal(prefs.value.defaultNoteColor, '#d2e3fc');
  auth.updateAccountPreferences = async () => { throw new Error('Storage failed'); };
  await assert.rejects(prefs.updateDefaultNoteColor('#e8d7ff'), /Storage failed/);
  assert.equal(prefs.value.defaultNoteColor, '#d2e3fc');
  await prefs.updateDefaultNoteColor('url(evil)');
  assert.equal(prefs.value.defaultNoteColor, '#d2e3fc');
});

test('only opening a fresh composer applies the preference; active drafts and existing notes retain explicit choices', () => {
  const source = fs.readFileSync('src/app/components/input/input.component.ts', 'utf8');
  const start = source.indexOf('  toggleNoteVisibility(');
  const method = source.slice(start, source.indexOf('\n  }', start) + 4);
  const scope = vm.createContext({});
  vm.runInContext(require('node:module').stripTypeScriptTypes(`class Editor { ${method} } globalThis.Editor = Editor;`), scope);
  const editor = new scope.Editor();
  Object.assign(editor, { isEditing: false, preferences: { value: { defaultNoteColor: '#d2e3fc' } }, currentNoteId: () => undefined,
    noteMain: { nativeElement: { hidden: true, style: {} } }, notePlaceholder: { nativeElement: {} }, updateTextColor() {} });
  editor.toggleNoteVisibility(true);
  assert.equal(editor.noteMain.nativeElement.style.backgroundColor, '#d2e3fc');
  editor.noteMain.nativeElement.style.backgroundColor = '';
  editor.toggleNoteVisibility(true);
  assert.equal(editor.noteMain.nativeElement.style.backgroundColor, '');
  editor.isEditing = true;
  editor.noteMain.nativeElement.hidden = true;
  editor.toggleNoteVisibility(true);
  assert.equal(editor.noteMain.nativeElement.style.backgroundColor, '');
});

test('new queued notes inherit a workspace default only when no explicit colour is supplied', async () => {
  const store = createStore();
  const workspace = await store.ensureServerWorkspace('default-colour');
  await store.patchWorkspace(workspace.id, current => ({ preferences: { ...current.preferences, defaultNoteColor: '#d2e3fc' } }));
  const inherited = await store.commitMutation(workspace, 'note.upsert', 'inherited', { noteBody: 'Text' });
  const explicit = await store.commitMutation(workspace, 'note.upsert', 'explicit', { noteBody: 'Text', bgColor: '' });
  assert.equal(inherited.bgColor, '#d2e3fc');
  assert.equal(explicit.bgColor, '');
  await store.commitMutation(workspace, 'note.upsert', 'explicit', { noteBody: 'Updated text' });
  assert.equal((await store.getNote(workspace.partition, explicit.id)).bgColor, '');
});
