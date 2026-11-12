const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadClass(path, name) {
  const exports = {};
  const decorator = () => value => value;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console, document: { addEventListener() {} }, require(name) {
    if (name.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
    if (name === '@angular/core') return { Injectable: decorator, Component: decorator, ViewChild: () => () => {}, Input: () => () => {}, HostBinding: () => () => {}, HostListener: () => () => {} };
    if (name === '@capacitor/core') return { registerPlugin: () => ({}), Capacitor: { getPlatform: () => 'ios' } };
    if (name.endsWith('/note-html')) return { sanitizeNoteHtml: text => text };
    return {};
  } });
  return exports[name];
}

const Input = loadClass('src/app/components/input/input.component.ts', 'InputComponent');
const Shared = loadClass('src/app/services/shared.service.ts', 'SharedService');
const foreign = { id: 1, name: 'From another note', added: true };
const work = { id: 2, name: 'Work', added: true };
const note = labels => ({ id: 42, ownerUserId: 7, noteTitle: 'My existing note', noteBody: '', labels, images: [], checkBoxes: [], bgColor: '', bgImage: '' });
const plain = value => JSON.parse(JSON.stringify(value));

function editor({ labels = [], editing = true, route = '/', catalog = [foreign, work] } = {}) {
  const component = Object.create(Input.prototype);
  const element = () => ({ nativeElement: { style: {}, dataset: {}, innerHTML: '' } });
  Object.assign(component, {
    Shared: { label: { list: plain(catalog) } }, isEditing: editing, noteToEdit: note(labels), activeEditors: [],
    router: { url: route }, auth: { currentUser: { id: 7 }, canonicalImageHtml: html => html, canonicalImageUrl: url => url },
    toggleNoteVisibility() {}, isCbox: { value: false, next(value) { this.value = value; } },
    noteTitle: element(), notePin: element(), noteMain: element(), noteContainer: element(),
    applyBackgroundImage() {}, updateTextColor() {}, normalizeCheckBoxes: rows => rows,
    loadCompletedChecklistCollapseState() {}, resetCboxHistory() {}, hasMeaningfulBody: () => false,
    cboxSuggestionEligibleIds: new Set(), cboxSuggestionDraftValues: new Map(), dismissedCboxSuggestionIds: new Set(),
    pendingAttachmentFiles: [],
    inputLength: { next() {} }, cd: { detectChanges() {} }, hydrateEditorLinkPreviews() {}, hydrateInlineImageButtons() {}
  });
  return component;
}

test('opening a server-owned unlabelled note on iOS never saves catalog selections from other notes', async () => {
  const component = editor();
  component.innerData(component.noteToEdit);
  const savedLabels = await component.labelsForSave();
  assert.deepEqual(plain(savedLabels), []);
  assert.equal(component.noteChangedForSave({ ...component.noteToEdit, labels: savedLabels }), false,
    'opening the note alone must not trigger a save with extra labels');
  assert.equal(component.labelsDirty, false);
  assert.equal(component.Shared.label.list[0].added, true, 'opening an editor must not mutate the supplied catalog');
});

test('opening a labelled note preserves only its own labels, including labels missing from the catalog', async () => {
  for (const catalog of [[foreign, work], [foreign], []]) {
    const component = editor({ labels: [work], catalog });
    component.innerData(component.noteToEdit);
    assert.deepEqual(plain(await component.labelsForSave()), [work]);
  }
});

test('new notes preselect only the current label route; the main overview starts with no labels', async () => {
  for (const route of ['/', '/label/Work']) {
    const component = editor({ editing: false, route });
    component.notePhClick();
    assert.deepEqual(plain(await component.labelsForSave()), route === '/' ? [] : [work]);
  }
});

test('the shared label catalog keeps names and ordering without carrying note membership', () => {
  const shared = Object.create(Shared.prototype);
  Object.assign(shared, { serverLabels: [], note: { all: [note([foreign, work])] }, label: { list: [] } });
  shared.refreshLabelList();
  assert.deepEqual(Array.from(shared.label.list, label => label.name), ['From another note', 'Work']);
  assert.ok(shared.label.list.every(label => label.added === false));
  assert.equal(shared.note.all[0].labels[0].added, true);
});
