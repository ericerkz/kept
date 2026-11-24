// node --test scripts/checklist-remove.test.cjs
// Issue #173 and the checklist overhaul: the toolbar's checklist button
// removes the list the cursor is in (with an Undo snackbar), and each list has
// a ··· menu to sort it, uncheck or delete its checked items, convert it to
// text or remove it ("Remove checklist (3 items)"). Removing or converting joins the surrounding text, turns the note
// plain when no list is left, and goes through the editor's Undo history.
// Backspace or Delete in a list with nothing in it removes it too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const snackbars = [];
const carets = [];
const fakeDocument = { body: { isConnected: true }, activeElement: null, createRange: () => {
  const steps = [];
  carets.push(steps);
  return { selectNodeContents: node => steps.push(['in', node]), setStart: (node, offset) => steps.push(['at', node, offset]),
    setStartAfter: node => steps.push(['after', node]), collapse: toStart => steps.push(['collapse', toStart]) };
} };
function load(file) {
  const exports = {};
  const decorator = () => value => value;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, {
    exports, console,
    Snackbar: { show: options => snackbars.push(options) },
    document: fakeDocument,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    require(id) {
      if (id === '@angular/core') return { Component: decorator, ViewChild: () => () => {}, Input: () => () => {}, HostBinding: () => () => {}, HostListener: () => () => {} };
      if (id.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
      if (/\/(checklist-sort|checkbox-indent|checklist-placement)$/.test(id)) return load(`src/app/utils/${id.split('/').at(-1)}.ts`);
      return {};
    }
  });
  return exports;
}
const { InputComponent } = load('src/app/components/input/input.component.ts');
const placement = load('src/app/utils/checklist-placement.ts');
const copy = value => JSON.parse(JSON.stringify(value));
const plain = value => String(value || '').replace(/<[^>]*>/g, '').trim();

function editorWith(parts, rows, { drafts = {}, active = 'a', separateCompleted = false } = {}) {
  const editor = Object.create(InputComponent.prototype);
  const applied = [], recorded = [], closed = [];
  Object.assign(editor, {
    activeChecklistId: active,
    preferences: { value: { moveCompletedChecklistItemsToBottom: separateCompleted } },
    Shared: { closeTooltip: el => closed.push(el) },
    checklistModeSnapshot: () => ({ titleHtml: '', bodyHtml: placement.serializeChecklistBody(parts), checkBoxes: copy(rows),
      drafts: { ...drafts }, isCbox: true, isHybridNote: false, showTextAfterChecklist: false }),
    editorBodyParts: () => copy(parts),
    applyChecklistModeSnapshot: snapshot => applied.push(copy(snapshot)),
    recordChecklistModeChange: before => recorded.push(copy(before)),
    notePlainText: plain,
    hasMeaningfulBody: value => !!plain(value)
  });
  return { editor, applied, recorded, closed };
}

test('removing a list drops its rows and joins the text around it, with no question asked', () => {
  const { editor, applied, recorded } = editorWith([
    { type: 'text', html: '<p>Intro</p>' }, { type: 'checklist', id: 'a' }, { type: 'text', html: '' },
    { type: 'checklist', id: 'b' }, { type: 'text', html: '<p>Outro</p>' }
  ], [{ id: 0, listId: 'a', data: 'milk', done: true }, { id: 1, listId: 'b', data: 'eggs', done: false }]);
  assert.equal(editor.removeChecklist('a'), 0, 'its position among the lists');
  assert.deepEqual(applied[0].checkBoxes.map(row => row.id), [1]);
  assert.equal(applied[0].bodyHtml, '<p>Intro</p>' + placement.checklistAnchorHtml('b') + '<p>Outro</p>');
  assert.equal(applied[0].isCbox, true);
  assert.equal(applied[0].isHybridNote, true);
  assert.equal(recorded.length, 1, 'recorded for Undo');
  assert.equal(editor.activeChecklistId, 'b');
});

test('removing the last list turns the note back into a plain note, joining the text on separate lines', () => {
  const { editor, applied } = editorWith([
    { type: 'text', html: 'Shopping' }, { type: 'checklist', id: 'default' }, { type: 'text', html: 'Thanks' }
  ], [{ id: 0, data: '', done: false }], { active: 'default', drafts: { default: 'unsaved' } });
  editor.removeChecklist('default');
  assert.equal(applied[0].isCbox, false);
  assert.deepEqual(applied[0].checkBoxes, []);
  assert.deepEqual(applied[0].drafts, {}, 'its unsaved new item goes with it');
  assert.equal(applied[0].bodyHtml, 'Shopping<br>Thanks');
  assert.equal(editor.activeChecklistId, 'default');
  assert.equal(editor.removeChecklist('missing'), -1);
});

test('convert to text keeps each item as a line where the list was, in the order shown', () => {
  const parts = [{ type: 'text', html: '<div>Before</div>' }, { type: 'checklist', id: 'a' }, { type: 'text', html: 'After' }];
  const rows = [{ id: 0, listId: 'a', data: 'done one', done: true }, { id: 1, listId: 'a', data: '<b>milk</b>', done: false },
    { id: 2, listId: 'a', data: '', done: false }];
  const separated = editorWith(parts, rows, { drafts: { a: 'eggs' }, separateCompleted: true });
  const menu = {};
  separated.editor.convertChecklistToText('a', menu);
  assert.deepEqual(separated.closed, [menu], 'its menu closes');
  assert.equal(separated.applied[0].bodyHtml, '<div>Before</div><div><b>milk</b></div><div>done one</div><div>eggs</div>After',
    'completed items last when they are shown last; empty rows dropped; an unsaved item kept');
  assert.equal(separated.applied[0].isCbox, false);
  assert.equal(separated.recorded.length, 1);

  const inOrder = editorWith(parts, rows);
  inOrder.editor.convertChecklistToText('a');
  assert.equal(inOrder.applied[0].bodyHtml, '<div>Before</div><div>done one</div><div><b>milk</b></div>After');
});

test('the toolbar button removes the list the cursor is in, and adds one otherwise', () => {
  const { editor } = editorWith([], []);
  const calls = [];
  const row = { isConnected: true, closest: () => ({ dataset: { checklistId: 'b' } }) };
  const title = { isConnected: true, closest: () => null };
  Object.assign(editor, {
    isCbox: { value: true }, noteContainer: { nativeElement: { contains: () => true } },
    removeChecklistWithUndo: id => calls.push(['remove', id]), insertChecklist: () => calls.push(['insert'])
  });
  editor.textHistoryTarget = row;
  assert.equal(editor.cursorChecklistId(), 'b');
  editor.toggleChecklist();
  editor.textHistoryTarget = title;
  assert.equal(editor.cursorChecklistId(), null);
  editor.toggleChecklist();
  editor.textHistoryTarget = { ...row, isConnected: false };
  assert.equal(editor.cursorChecklistId(), null, 'a removed row does not count');
  editor.textHistoryTarget = row;
  editor.isCbox.value = false;
  assert.equal(editor.cursorChecklistId(), null, 'a plain note has no list');
  assert.deepEqual(calls, [['remove', 'b'], ['insert']]);
});

test('removing from the toolbar offers Undo in a snackbar and moves the cursor to the text', () => {
  const { editor } = editorWith([], []);
  const focused = [], steps = [];
  const body = { getClientRects: () => [1], focus: () => focused.push('body') };
  Object.assign(editor, {
    removeChecklist: () => 0, checklistBlocks: [], checklistDrafts: () => [],
    noteBody: { nativeElement: body }, stepChecklistModeHistory: command => steps.push(command)
  });
  snackbars.length = 0;
  editor.removeChecklistWithUndo('a');
  assert.deepEqual(focused, ['body']);
  assert.equal(snackbars.length, 1);
  assert.equal(snackbars[0].text, 'Checklist removed');
  assert.equal(snackbars[0].actionText, 'Undo');
  snackbars[0].onActionClick();
  assert.deepEqual(steps, ['undo']);

  Object.assign(editor, { removeChecklist: () => -1 });
  editor.removeChecklistWithUndo('missing');
  assert.equal(snackbars.length, 1, 'nothing to undo, no snackbar');
});

// An editor whose DOM fields are stand-ins: the new-item row of each list and
// the text body the caret returns to.
function emptyListEditor(parts, rows, { drafts = {}, bodyNodes = [] } = {}) {
  const harness = editorWith(parts, rows, { drafts, active: 'a' });
  const focused = [];
  const draftEl = id => ({ dataset: { checklistDraft: id }, innerHTML: drafts[id] || '', focus: () => focused.push(`draft:${id}`) });
  const body = { childNodes: bodyNodes, getClientRects: () => [1], focus: () => focused.push('body') };
  Object.assign(harness.editor, {
    checkBoxes: copy(rows), checklistBlocks: [], cd: { detectChanges() {} },
    checklistDrafts: () => parts.filter(part => part.type === 'checklist').map(part => draftEl(part.id)),
    noteBody: { nativeElement: body }, bodyAfterChecklist: () => undefined,
    htmlNodeCount: html => (String(html).match(/<div>/g) || [html]).length
  });
  const key = (key, currentTarget, extra = {}) => {
    let prevented = false;
    return { key, keyCode: key === 'Backspace' ? 8 : 46, isComposing: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      currentTarget, target: currentTarget, preventDefault: () => { prevented = true }, get prevented() { return prevented }, ...extra };
  };
  return { ...harness, focused, body, draftEl, key };
}

test('Backspace or Delete in the new-item row of an empty list removes it, caret where it was', () => {
  const lines = [{ nodeType: 1, nodeName: 'DIV' }, { nodeType: 1, nodeName: 'DIV' }];
  const { editor, applied, recorded, focused, draftEl, key } = emptyListEditor(
    [{ type: 'text', html: '<div>Shopping</div><div>for</div>' }, { type: 'checklist', id: 'a' }], [], { bodyNodes: lines });
  carets.length = 0;
  const backspace = key('Backspace', draftEl('a'));
  editor.cboxPhKeyDown(backspace);
  assert.equal(backspace.prevented, true);
  assert.equal(applied[0].isCbox, false, 'the note is plain again');
  assert.equal(applied[0].bodyHtml, '<div>Shopping</div><div>for</div>');
  assert.equal(recorded.length, 1, 'Undo brings it back');
  assert.deepEqual(focused, ['body']);
  assert.deepEqual(carets.at(-1), [['in', lines[1]], ['collapse', false]], 'at the end of the text above');

  for (const press of [key('Delete', draftEl('a')), { inputType: 'deleteContentBackward', isComposing: false, currentTarget: draftEl('a'), preventDefault() { this.prevented = true } },
    { inputType: 'deleteContentForward', isComposing: false, currentTarget: draftEl('a'), preventDefault() { this.prevented = true } }]) {
    const harness = emptyListEditor([{ type: 'text', html: 'Note' }, { type: 'checklist', id: 'a' }], [], { bodyNodes: [{ nodeType: 3, nodeName: '#text', textContent: 'Note' }] });
    if (press.inputType) harness.editor.cboxPhBeforeInput(press); else harness.editor.cboxPhKeyDown(press);
    assert.equal(press.prevented, true, `${press.key || press.inputType} removes it`);
    assert.equal(harness.applied[0].isCbox, false);
  }
});

test('the only item of a list, when empty, removes the list on Backspace or Delete', () => {
  const rows = [{ id: 4, listId: 'b', data: '', done: false }];
  const parts = [{ type: 'text', html: '' }, { type: 'checklist', id: 'a' }, { type: 'text', html: '' }, { type: 'checklist', id: 'b' }, { type: 'text', html: '<div>After</div>' }];
  const { editor, applied, key } = emptyListEditor(parts, [{ id: 1, listId: 'a', data: 'milk', done: false }, ...rows]);
  const row = { dataset: { cboxId: '4' }, innerHTML: '<br>' };
  assert.equal(editor.removeEmptyChecklistFrom(row), true);
  assert.equal(applied[0].isCbox, true, 'the other list stays');
  assert.deepEqual(applied[0].checkBoxes.map(item => item.id), [1]);
  assert.equal(applied[0].bodyHtml, placement.checklistAnchorHtml('a') + '<div>After</div>');

  const mobile = emptyListEditor(parts, rows);
  const press = { inputType: 'deleteContentBackward', isComposing: false, currentTarget: { dataset: { cboxId: '4' }, innerHTML: '' }, preventDefault() { this.prevented = true } };
  mobile.editor.cboxBeforeInput(press, 4);
  assert.equal(press.prevented, true, 'from a phone keyboard too');
});

test('Backspace and Delete leave lists with anything in them alone', () => {
  const parts = [{ type: 'text', html: 'Note' }, { type: 'checklist', id: 'a' }];
  const cases = [
    ['the new-item row of a list with items', [{ id: 1, listId: 'a', data: 'milk' }], {}, { dataset: { checklistDraft: 'a' }, innerHTML: '' }],
    ['a new item with text', [], { a: 'eg' }, { dataset: { checklistDraft: 'a' }, innerHTML: 'eg' }],
    ['an item with text', [{ id: 1, listId: 'a', data: 'milk' }], {}, { dataset: { cboxId: '1' }, innerHTML: 'milk' }],
    ['an empty item with another item', [{ id: 1, listId: 'a', data: '' }, { id: 2, listId: 'a', data: 'eggs' }], {}, { dataset: { cboxId: '1' }, innerHTML: '' }],
    ['the only empty item while a new one is typed', [{ id: 1, listId: 'a', data: '' }], { a: 'eggs' }, { dataset: { cboxId: '1' }, innerHTML: '' }]
  ];
  for (const [name, rows, drafts, field] of cases) {
    const { editor, applied } = emptyListEditor(parts, rows, { drafts });
    assert.equal(editor.removeEmptyChecklistFrom(field), false, name);
    assert.deepEqual(applied, [], name);
  }
  const { editor, applied, draftEl, key } = emptyListEditor(parts, []);
  editor.cboxPhKeyDown(key('Backspace', draftEl('a'), { shiftKey: true }));
  editor.cboxPhKeyDown(key('Backspace', draftEl('a'), { ctrlKey: true }));
  assert.deepEqual(applied, [], 'only a plain Backspace or Delete');
});

test('"Remove checklist" says how many items go with the list', () => {
  const { editor } = editorWith([], []);
  const drafts = [{ dataset: { checklistDraft: 'a' }, innerHTML: '' }, { dataset: { checklistDraft: 'b' }, innerHTML: 'typed&nbsp;' }];
  Object.assign(editor, {
    checklistDrafts: () => drafts, isCbox: { value: true }, noteContainer: { nativeElement: { contains: () => true } },
    checkBoxes: [{ id: 0, listId: 'a', data: 'milk' }, { id: 1, listId: 'a', data: '<b>eggs</b>' }, { id: 2, listId: 'a', data: '<br>' },
      { id: 3, listId: 'b', data: '' }]
  });
  assert.equal(editor.checklistItemCount('a'), 2, 'rows with text only');
  assert.equal(editor.checklistItemCount('b'), 1, 'an item typed but not yet added counts');
  assert.equal(editor.checklistItemCount(null), 0);
  assert.equal(editor.removeChecklistLabel('a'), 'Remove checklist (2 items)');
  assert.equal(editor.removeChecklistLabel('b'), 'Remove checklist (1 item)');
  drafts[1].innerHTML = '';
  assert.equal(editor.removeChecklistLabel('b'), 'Remove checklist', 'an empty list has no count');
  editor.textHistoryTarget = { isConnected: true, closest: () => ({ dataset: { checklistId: 'a' } }) };
  assert.equal(editor.checklistToggleLabel(), 'Remove checklist (2 items)', 'the toolbar tooltip too');
  editor.textHistoryTarget = { isConnected: true, closest: () => null };
  assert.equal(editor.checklistToggleLabel(), 'Insert checklist');
});

test('the list menu works from the keyboard: Enter and Space activate, Escape closes', () => {
  const { editor } = editorWith([], []);
  const log = [];
  const menuItems = new Set();
  const menu = { contains: el => menuItems.has(el) };
  const button = { isConnected: true, focus: () => { log.push('button focused'); fakeDocument.activeElement = button; } };
  editor.Shared = { closeTooltip: el => { log.push(el === menu ? 'closed' : 'closed other'); fakeDocument.activeElement = fakeDocument.body; } };
  const item = { click: () => { log.push('clicked'); fakeDocument.activeElement = fakeDocument.body; } };
  const key = (name, target = { closest: () => item }) => {
    const event = { key: name, target, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    editor.checklistMenuKey(event, menu, button);
    return event.prevented;
  };
  assert.equal(key('Enter'), true);
  assert.equal(key(' '), true);
  assert.deepEqual(log, ['clicked', 'button focused', 'clicked', 'button focused'], 'activated, and focus returns to the ··· button');
  log.length = 0;
  assert.equal(key('Escape'), true);
  assert.deepEqual(log, ['closed', 'button focused']);
  log.length = 0;
  assert.equal(key('a'), false, 'other keys pass through');
  assert.equal(key('Enter', { closest: () => null }), false, 'Enter outside an item does nothing');
  const textElsewhere = { isConnected: true };
  item.click = () => { log.push('clicked'); fakeDocument.activeElement = textElsewhere; };
  key('Enter');
  assert.deepEqual(log, ['clicked'], 'focus that moved on (Remove checklist moves it to the text) stays there');
});

test('the text above and below joins without gluing lines or adding a blank one', () => {
  const editor = editorWith([], []).editor;
  assert.equal(editor.joinBodyHtml('one', 'two'), 'one<br>two');
  assert.equal(editor.joinBodyHtml('<p>one</p>', '<p>two</p>'), '<p>one</p><p>two</p>');
  assert.equal(editor.joinBodyHtml('one<br>', 'two'), 'one<br>two');
  assert.equal(editor.joinBodyHtml('one', '<div>two</div>'), 'one<div>two</div>');
  assert.equal(editor.joinBodyHtml('', '<p>two</p>'), '<p>two</p>');
  assert.equal(editor.joinBodyHtml('<p>one</p>', '<br>'), '<p>one</p>', 'an empty line below is dropped');
});

test('the menus and toolbar are wired as designed', () => {
  const html = fs.readFileSync('src/app/components/input/input.component.html', 'utf8');
  const toolbars = html.match(/<div class="(?:mobile-icon check )?checklist-action[^>]*>/g);
  assert.equal(toolbars.length, 2, 'desktop and mobile toolbars');
  for (const tag of toolbars) {
    assert.match(tag, /\[class\.active\]="inChecklist(Mobile)?"/);
    assert.match(tag, /\(click\)="toggleChecklist\(\)"/);
    assert.match(tag, /\[attr\.aria-label\]="checklistLabel(Mobile)?"/, 'labelled with the item count when removing');
  }
  const listMenu = html.slice(html.indexOf('<div #checklistMenuTt'), html.indexOf('<!--? isDone: true -->'));
  for (const action of ["sortCboxItems(checklistMenuTt, listId)", "uncheckAllCboxItems(checklistMenuTt, listId)",
    "deleteAllCompletedCboxItems(checklistMenuTt, listId)", "convertChecklistToText(listId, checklistMenuTt)", "removeChecklistWithUndo(listId)", "removeChecklistLabel(listId)"]) {
    assert.ok(listMenu.includes(action), action);
  }
  assert.ok(listMenu.indexOf('role="separator"') < listMenu.indexOf('removeChecklistWithUndo'), 'Remove checklist last, after a divider');
  assert.match(listMenu, /\(keydown\)="checklistMenuKey\(\$event, checklistMenuTt, checklistMenuBtn\)"/, 'keyboard support');
  for (const item of listMenu.match(/<div role="menuitem"[^>]*>/g)) assert.match(item, /tabindex/, `${item} is focusable`);
  assert.doesNotMatch(html, /completedItemsMenu|completed-items-menu/, 'the Completed items header has no separate menu');
  const moreMenu = html.slice(html.indexOf('<div #moreMenuTt'), html.indexOf('<div #moreMenuTt') + 4000);
  assert.doesNotMatch(moreMenu, /sort_a_to_z|uncheck_all_items/, 'moved out of the note menu');
  const en = JSON.parse(fs.readFileSync('translations/en.json', 'utf8')).shared;
  for (const key of ['input.checklist_actions', 'input.checklist_removed', 'input.remove_checklist', 'input.remove_checklist_count.one',
    'input.remove_checklist_count.other', 'code.convert_to_text']) assert.ok(en[key], key);
});
