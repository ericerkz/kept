// node --test scripts/encrypted-note-card.test.cjs
// Overview cards of unlocked encrypted notes (issue #27): they show decrypted
// copies, edit checklists through sealed saves, decrypt downloads and images,
// redraw when the unlock runs out, and show link cards without sending the note's links
// to the server for a preview.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadNotesComponent(globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/components/notes/notes.component.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console, setTimeout, clearTimeout, Date, ...globals, require(name) {
    if (name === '@angular/core') return {
      ...Object.fromEntries(['Component', 'Injectable', 'Pipe'].map(key => [key, () => value => value])),
      ...Object.fromEntries(['ViewChild', 'ViewChildren', 'HostListener'].map(key => [key, () => () => {}]))
    };
    if (name === '@capacitor/core') return { registerPlugin: () => ({}) };
    if (name.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
    if (name.endsWith('/checklist-placement')) return { checklistBodyParts: body => [{ type: 'text', html: body }], checklistAnchorHtml: () => '', checklistId: row => row.listId || 'default' };
    if (name.endsWith('/checkbox-indent')) return { descendantIndexes: () => [], normalizeIndentLevel: level => level || 0, normalizeIndentLevels: rows => rows };
    if (name.endsWith('/note-appearance')) return { noteAppearance: () => ({ text: '#000' }) };
    if (name.endsWith('/note-html')) return { hasJoinedNoteUrls: () => false };
    return {};
  } });
  return exports.NotesComponent;
}

const event = () => ({ type: 'click', stopPropagation() {}, preventDefault() {} });
const copy = value => JSON.parse(JSON.stringify(value));

function harness({ hidden = false, openable = true, globals } = {}) {
  const NotesComponent = loadNotesComponent({ document: { body: { classList: { contains: () => false } } }, ...globals });
  const component = Object.create(NotesComponent.prototype);
  const decrypted = {
    noteBody: '<p>Plan at https://private.example/plan</p>',
    checkBoxes: [{ id: 1, data: 'milk', done: false, listId: 'a' }, { id: 2, data: 'eggs', done: false, listId: 'a' }],
    images: [], files: {}
  };
  const card = { noteBody: decrypted.noteBody, checkBoxes: copy(decrypted.checkBoxes), images: [],
    attachments: [{ id: 9, syncId: 'f1', originalName: 'plan.pdf', encrypted: true }] };
  const log = { writes: [], opened: [], fetched: [], downloads: [], messages: [], redraws: 0, segments: [], prepared: [] };
  Object.assign(component, {
    noteMetaCache: new WeakMap(),
    cardImageRequests: new WeakMap(),
    encryptedImagesVersion: 0, cardImageRecovery: 0, cardImageRecoveryAt: 0,
    preferences: { value: { richLinkPreviews: true } },
    auth: { authenticatedImageHtml: html => html },
    cd: { markForCheck() { log.redraws++ } },
    showMessage: message => log.messages.push(message),
    scheduleBuildMasonry() {},
    ignoreSyntheticOverviewCheckboxMouse: () => false,
    buildBodySegments(html, richLinkPreviews) { log.segments.push({ html, richLinkPreviews }); return { segments: [], urls: [] } },
    noteLock: {
      isEncrypted: note => note.lockHash === 'e2e',
      lockPreviewHidden: () => hidden,
      cardContent: () => card,
      unlockExpiresAt: () => component.expiresAt,
      content: () => decrypted,
      rememberRows() {},
      async openExternal(note) { log.opened.push(note.id); return openable ? note : null }
    },
    notesService: {
      async updateKey(payload, id) { log.writes.push({ payload: copy(payload), id }) },
      async get(id) { log.fetched.push(id); return { id, locked: true, lockHash: 'e2e', encryptedContent: 'envelope' } },
      async downloadAttachment(attachment) { log.downloads.push(['stored', attachment.id]) }
    },
    encryptedFiles: {
      async download(note, attachment) { log.downloads.push(['decrypted', note.id, attachment.syncId]) },
      async prepare(note) { log.prepared.push(note.id); return true }
    }
  });
  const encryptedNote = { id: 7, locked: true, lockSalt: 's', lockHash: 'e2e', noteTitle: 'Diary', noteBody: '', checkBoxes: [], images: [], encryptedContent: 'envelope' };
  return { component, card, decrypted, log, encryptedNote };
}

test('ticking a row on an unlocked encrypted card saves an edited copy after catching up with the stored note', async () => {
  const { component, card, decrypted, log, encryptedNote } = harness();
  await component.toggleOverviewCheckbox(encryptedNote, card.checkBoxes[0], event());
  assert.deepEqual(log.opened, [7], 'the stored version is decrypted before editing');
  assert.deepEqual(log.writes, [{ id: 7, payload: { checkBoxes: [{ id: 1, data: 'milk', done: true, listId: 'a' }, { id: 2, data: 'eggs', done: false, listId: 'a' }] } }]);
  assert.equal(card.checkBoxes[0].done, false, 'the card rows are never edited');
  assert.equal(decrypted.checkBoxes[0].done, false, 'the unlocked content changes only through the sealed save');
  assert.deepEqual(encryptedNote.checkBoxes, [], 'no checklist is written onto the encrypted note');
});

test('removing a row from an unlocked encrypted card keeps the rest of the checklist', async () => {
  const { component, card, log, encryptedNote } = harness();
  await component.removeOverviewCheckbox(encryptedNote, card.checkBoxes[1], event());
  assert.deepEqual(log.writes, [{ id: 7, payload: { checkBoxes: [{ id: 1, data: 'milk', done: false, listId: 'a' }] } }]);
});

test('a card preview is fetched in full, and nothing is saved when the card is locked or the note cannot be decrypted', async () => {
  const preview = harness();
  await preview.component.toggleOverviewCheckbox({ ...preview.encryptedNote, isCardPreview: true }, preview.card.checkBoxes[0], event());
  assert.deepEqual(preview.log.fetched, [7]);
  assert.equal(preview.log.writes.length, 1);

  const locked = harness({ hidden: true });
  await locked.component.toggleOverviewCheckbox(locked.encryptedNote, locked.card.checkBoxes[0], event());
  assert.deepEqual(locked.log.writes, [], 'a locked card never writes');

  const changedElsewhere = harness({ openable: false });
  await changedElsewhere.component.removeOverviewCheckbox(changedElsewhere.encryptedNote, changedElsewhere.card.checkBoxes[0], event());
  assert.deepEqual(changedElsewhere.log.writes, [], 'an empty or stale checklist is never sealed over the stored one');
});

test('plain notes keep the existing card checklist behaviour', async () => {
  const { component, log } = harness();
  const plain = { id: 3, noteBody: '', checkBoxes: [{ id: 1, data: 'milk', done: false }] };
  await component.toggleOverviewCheckbox(plain, plain.checkBoxes[0], event());
  assert.equal(plain.checkBoxes[0].done, true);
  assert.deepEqual(log.writes, [{ id: 3, payload: { checkBoxes: [{ id: 1, data: 'milk', done: true }] } }]);
  assert.deepEqual(log.opened, []);
});

test('downloading from an encrypted card decrypts the file; other attachments download as stored', async () => {
  const { component, card, log, encryptedNote } = harness();
  await component.downloadAttachment(card.attachments[0], event(), encryptedNote);
  await component.downloadAttachment({ id: 4, syncId: 'p1', originalName: 'plain.txt' }, event(), { id: 3 });
  assert.deepEqual(log.downloads, [['decrypted', 7, 'f1'], ['stored', 4]]);
});

test('an unlocked encrypted card lays out its decrypted body, with offline link cards', () => {
  const { component, log, encryptedNote } = harness();
  component.noteBodySegments(encryptedNote);
  assert.deepEqual(log.segments, [{ html: '<p>Plan at https://private.example/plan</p>', richLinkPreviews: true }]);
  assert.equal(component.cardBodyLength(encryptedNote), '<p>Plan at https://private.example/plan</p>'.length);
  assert.deepEqual(copy(component.cardAttachments(encryptedNote)), [{ id: 9, syncId: 'f1', originalName: 'plan.pdf', encrypted: true }]);
  const html = fs.readFileSync('src/app/components/notes/notes.component.html', 'utf8');
  const previews = html.match(/<app-link-preview[^>]*>/g);
  assert.ok(previews.length >= 2);
  for (const tag of previews) {
    assert.match(tag, /\[offline\]="noteLock\.isEncrypted\(note\)"/, `${tag} is offline for encrypted notes`);
    assert.match(tag, /\[stored\]="noteLock\.storedLinkPreview\(note, /, `${tag} shows the preview kept from before locking`);
  }
});

function loadLinkPreview() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/components/link-preview/link-preview.component.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console, URL, setTimeout, window: {}, require(name) {
    if (name === '@angular/core') return { Component: () => value => value, Input: () => () => {} };
    if (name.endsWith('/environment')) return { environment: { apiUrl: '/api' } };
    return {};
  } });
  const fetched = [], thumbnails = [], pending = [];
  const component = new exports.LinkPreviewComponent(
    { getLinkPreview: url => { fetched.push(url); return new Promise(resolve => pending.push(resolve)) } },
    { prepareImageUrl: async url => { thumbnails.push(url); return url } },
    { nativeElement: {} });
  return { component, fetched, thumbnails, pending };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('an offline link card shows the domain and never asks the server', async () => {
  const { component, fetched, thumbnails, pending } = loadLinkPreview();
  component.url = 'https://private.example/plan';
  component.offline = true;
  component.ngAfterViewInit();
  await component.fetchPreview();
  assert.deepEqual(fetched, [], 'nothing is requested for an encrypted note\'s link');
  assert.equal(component.loading, false);
  assert.equal(component.preview, null);
  assert.equal(component.linkDomain(component.url), 'private.example');

  // When the lock is removed, the card fetches its preview as usual.
  component.offline = false;
  assert.deepEqual(fetched, ['https://private.example/plan']);
  // Locked again while that request runs: its result is dropped, so no
  // thumbnail is requested through the server either.
  component.offline = true;
  pending[0]({ title: 'Plan', domain: 'private.example', url: 'https://private.example/plan', image: 'https://private.example/og.png' });
  await settle();
  assert.deepEqual(thumbnails, []);
  assert.equal(component.preview, null);
  assert.equal(component.loading, false);
});

test('an offline card shows the preview kept from before locking, without any request', async () => {
  const { component, fetched, thumbnails } = loadLinkPreview();
  const thumb = 'data:image/webp;base64,VGh1bWI=';
  component.url = 'https://private.example/plan';
  component.offline = true;
  component.stored = { url: 'https://private.example/plan', title: 'Private plan', domain: 'private.example', description: null, image: thumb };
  component.ngAfterViewInit();
  assert.equal(component.preview.title, 'Private plan');
  assert.equal(component.thumbnailUrl, thumb, 'the kept data: thumbnail is shown as is');
  component.stored = { url: 'https://private.example/plan', title: 'Private plan', domain: 'private.example', description: null, image: 'https://private.example/og.png' };
  assert.equal(component.preview.image, null, 'a remote image address is never loaded');
  assert.equal(component.thumbnailUrl, '');
  component.stored = null;
  assert.equal(component.preview, null, 'without a kept preview, the card shows the domain');
  await settle();
  assert.deepEqual(fetched, []);
  assert.deepEqual(thumbnails, []);
});

test('an unlocked encrypted card decrypts its images once, then lays out again with them', async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const { component, log, encryptedNote } = harness();
  component.noteBodySegments(encryptedNote);
  assert.equal(component.lockedCardHidden(encryptedNote), false);
  component.lockedCardHidden(encryptedNote);
  await settle();
  assert.deepEqual(log.prepared, [7], 'once per unlocked content');
  assert.equal(log.redraws, 1);
  component.noteBodySegments(encryptedNote);
  assert.equal(log.segments.length, 2, 'the card\'s cached layout is rebuilt with the decrypted images');
  component.noteBodySegments(encryptedNote);
  assert.equal(log.segments.length, 2, 'and cached again after that');

  const preview = harness();
  preview.component.lockedCardHidden({ ...preview.encryptedNote, isCardPreview: true });
  await settle();
  assert.deepEqual(preview.log.fetched, [7], 'a card copy is fetched in full for its attachment rows');
  assert.deepEqual(preview.log.prepared, [7]);

  const locked = harness({ hidden: true });
  assert.equal(locked.component.lockedCardHidden(locked.encryptedNote), true);
  await settle();
  assert.deepEqual(locked.log.prepared, [], 'a locked card decrypts nothing');

  const source = fs.readFileSync('src/app/components/notes/note-preview-images.component.ts', 'utf8');
  assert.match(source, /if \(!image \|\| !tile\.clientWidth \|\| isPendingEncrypted\(image\.src\)\) return;/, 'a tile waits for the decrypted copy instead of loading kept://file/');
  assert.match(source, /image\.pending === this\.renderedImages\[i\]\.pending/, 'a tile reloads once its decrypted copy arrives');
});

test('an unlocked card redraws when its unlock runs out', () => {
  const timers = [];
  const { component, log, encryptedNote } = harness({ globals: {
    setTimeout: (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer },
    clearTimeout: timer => { if (timer) timer.cleared = true }
  } });
  const now = Date.now();
  component.expiresAt = now + 60_000;
  assert.equal(component.lockedCardHidden(encryptedNote), false);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay >= 60_000 && timers[0].delay < 61_000);

  component.expiresAt = now + 120_000;
  component.lockedCardHidden(encryptedNote);
  assert.equal(timers.length, 1, 'a later expiry waits for the earlier timer');

  component.expiresAt = now + 30_000;
  component.lockedCardHidden(encryptedNote);
  assert.equal(timers.length, 2);
  assert.equal(timers[0].cleared, true, 'an earlier expiry replaces the timer');
  timers[1].callback();
  assert.equal(log.redraws, 1);
});

test('the editor shows an encrypted note\'s kept previews or domain cards without asking the server', async () => {
  const source = fs.readFileSync('src/app/components/input/input.component.ts', 'utf8');
  assert.equal(source.match(/getLinkPreview\(/g)?.length, 1, 'the editor requests previews in one place');
  assert.match(source, /this\.editorLinkPreview\(url\)\s*\.then/, 'preview slots go through editorLinkPreview');
  const start = source.indexOf('  private editorLinkPreview(');
  const method = source.slice(start, source.indexOf('\n  }', start) + 4).replace('private ', '');
  const scope = vm.createContext({ Promise });
  vm.runInContext(require('node:module').stripTypeScriptTypes(`class Editor { ${method} } globalThis.Editor = Editor;`), scope);
  const fetched = [];
  const editor = noteToEdit => Object.assign(new scope.Editor(), {
    noteToEdit, noteLock: { isEncrypted: note => note?.lockHash === 'e2e',
      storedLinkPreview: (note, url) => url === 'https://kept.example/' ? { url, title: 'Kept', domain: 'kept.example', description: null, image: null } : null },
    notesService: { async getLinkPreview(url) { fetched.push(url); return { title: 'Plan', domain: 'example.com', url } } }
  });
  assert.equal(await editor({ id: 1, locked: true, lockHash: 'e2e' }).editorLinkPreview('https://private.example/plan'), undefined,
    'no preview data: the card shows the link\'s domain');
  assert.equal((await editor({ id: 1, locked: true, lockHash: 'e2e' }).editorLinkPreview('https://kept.example/')).title, 'Kept',
    'a preview kept from before locking');
  assert.deepEqual(fetched, []);
  assert.equal((await editor({ id: 2 }).editorLinkPreview('https://public.example')).title, 'Plan');
  assert.equal((await editor(undefined).editorLinkPreview('https://new.example')).title, 'Plan', 'a new note composer keeps previews');
  assert.deepEqual(fetched, ['https://public.example', 'https://new.example']);
});

test('failed card images stay quiet on redraw, retry after recovery, and cache success', async () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  const { component, log, encryptedNote } = harness();
  let ready = false;
  component.encryptedFiles.prepare = async note => { log.prepared.push(note.id); return ready; };
  component.lockedCardHidden(encryptedNote);
  await settle();
  for (let i = 0; i < 10; i++) component.lockedCardHidden(encryptedNote);
  await settle();
  assert.equal(log.prepared.length, 1, 'failed decryption is not retried by change detection');
  ready = true;
  component.recoverCardImages();
  component.recoverCardImages();
  await settle();
  component.lockedCardHidden(encryptedNote);
  await settle();
  assert.equal(log.prepared.length, 2, 'coalesced recovery permits one retry');
  component.cardImageRecovery++;
  component.lockedCardHidden(encryptedNote);
  await settle();
  assert.equal(log.prepared.length, 2, 'successful images remain cached across recovery');
});

test('recovery does not overlap image preparation or decrypt a card relocked during fetch', async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const { component, log, encryptedNote } = harness();
  let finish;
  component.encryptedFiles.prepare = async note => {
    log.prepared.push(note.id);
    return new Promise(resolve => { finish = resolve; });
  };
  component.lockedCardHidden(encryptedNote);
  component.cardImageRecovery++;
  component.lockedCardHidden(encryptedNote);
  assert.equal(log.prepared.length, 1);
  finish(false);
  await settle();
  component.lockedCardHidden(encryptedNote);
  assert.equal(log.prepared.length, 1, 'a recovery during the request cannot cause a redraw retry loop');
  component.cardImageRecovery++;
  component.lockedCardHidden(encryptedNote);
  assert.equal(log.prepared.length, 2);
  finish(true);
  await settle();

  const preview = harness();
  let fetched;
  preview.component.notesService.get = () => new Promise(resolve => { fetched = resolve; });
  preview.component.lockedCardHidden({ ...preview.encryptedNote, isCardPreview: true });
  preview.component.noteLock.lockPreviewHidden = () => true;
  fetched(preview.encryptedNote);
  await settle();
  assert.equal(preview.log.prepared.length, 0, 'relocked cards do not start decryption after the fetch');
});

test('a failed full-note fetch can be retried after recovery', async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const { component, log, encryptedNote } = harness();
  const preview = { ...encryptedNote, isCardPreview: true };
  component.notesService.get = async () => { throw new Error('offline fixture'); };
  component.lockedCardHidden(preview);
  await settle();
  component.lockedCardHidden(preview);
  assert.equal(log.prepared.length, 0);
  component.notesService.get = async () => encryptedNote;
  component.cardImageRecovery++;
  component.lockedCardHidden(preview);
  await settle();
  assert.deepEqual(log.prepared, [7]);
});
