import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKeptMcpServer } from './server.mjs';
import { KeptClient } from './kept-client.mjs';
import { startFixture } from '../test-support/session-fixture.cjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const palette = require('../shared/note-palette.json');
const appearance = require('../shared/note-appearance.json');

async function withMcpClient(keptClient, run, options) {
  const server = createKeptMcpServer(keptClient, options);
  const client = new Client({ name: 'kept-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { await run(client); } finally { await Promise.all([client.close(), server.close()]); }
}

function stubKeptClient(overrides = {}) {
  return {
    searchNotes: async () => [], getNote: async noteId => ({ id: noteId, ownerUserId: 1, noteTitle: 'Note', checkBoxes: [], images: [] }),
    requestLockedNoteAccess: async noteId => ({ unlocked: false, unlockUrl: `https://kept.test/unlock/${noteId}` }),
    listLabels: async () => [], resolveLabels: async names => names.map((name, index) => ({ id: index + 1, name, added: true })),
    createNote: async note => ({ id: 11, ...note }), updateNote: async (noteId, changes) => ({ id: noteId, ...changes }),
    assertNoteOwner: async () => undefined, setLifecycle: async (noteId, state) => ({ ok: true, noteId, state }),
    permanentlyDeleteNote: async noteId => ({ ok: true, noteId }), listReminders: async () => [],
    createReminder: async reminder => ({ id: 1, ...reminder }), updateReminder: async (id, changes) => ({ id, ...changes }),
    deleteReminder: async reminderId => ({ ok: true, reminderId }), searchUsers: async () => [],
    setCollaborators: async (noteId, userIds) => ({ noteId, userIds }), uploadAttachment: async () => ({ id: 4 }),
    uploadImage: async file => ({ url: '/api/uploads/images/test.png', name: file.filename }),
    fileParamToUpload: async (file, { kind }) => ({ filename: file.file_name || kind, mimeType: file.mime_type, base64Data: Buffer.from('file').toString('base64') }),
    readImage: async () => ({ contentType: 'image/png', base64Data: Buffer.from('png').toString('base64') }),
    readAttachment: async () => ({ contentType: 'text/plain', base64Data: Buffer.from('hello').toString('base64') }),
    deleteAttachment: async (noteId, attachmentId) => ({ ok: true, noteId, attachmentId }), ...overrides
  };
}

const expectedTools = [
  'kept_add_image', 'kept_archive_note', 'kept_create_note', 'kept_delete_attachment', 'kept_delete_image', 'kept_delete_reminder',
  'kept_get_appearance_options', 'kept_get_note', 'kept_list_labels', 'kept_list_reminders', 'kept_manage_checklist', 'kept_permanently_delete_note',
  'kept_read_attachment', 'kept_read_image', 'kept_request_locked_note_access', 'kept_restore_note', 'kept_search_notes', 'kept_search_users',
  'kept_set_collaborators', 'kept_set_reminder', 'kept_trash_note', 'kept_update_note', 'kept_update_reminder',
  'kept_upload_attachment'
].sort();

test('server advertises the complete Kept tool set and safety annotations', async () => {
  await withMcpClient(stubKeptClient(), async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), expectedTools);
    assert.equal(tools.find(tool => tool.name === 'kept_search_notes').annotations.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === 'kept_permanently_delete_note').annotations.destructiveHint, true);
  });
});

test('create maps rich fields, sanitizes HTML, and resolves labels', async () => {
  let received;
  await withMcpClient(stubKeptClient({ createNote: async note => { received = note; return { id: 12, ...note }; } }), async client => {
    const result = await client.callTool({ name: 'kept_create_note', arguments: {
      title: '<b>Agent</b>', body: '<p>Hello</p><script>alert(1)</script><a href="javascript:bad()">bad</a>', format: 'html',
      binder: 'Automation', labels: ['agent'], pinned: true
    } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.result.id, 12);
  });
  assert.equal(received.noteTitle, 'Agent');
  assert.match(received.noteBody, /<p>Hello<\/p>/);
  assert.doesNotMatch(received.noteBody, /script|javascript/i);
  assert.deepEqual(received.labels, [{ id: 1, name: 'agent', added: true }]);
});

test('plain text is escaped rather than interpreted as HTML', async () => {
  let received;
  await withMcpClient(stubKeptClient({ createNote: async note => { received = note; return note; } }), async client => {
    await client.callTool({ name: 'kept_create_note', arguments: { body: '<b>literal</b>\nnext' } });
  });
  assert.equal(received.noteBody, '&lt;b&gt;literal&lt;/b&gt;<br>next');
});

test('checklist operations preserve existing items and update one item', async () => {
  let changes;
  await withMcpClient(stubKeptClient({
    getNote: async () => ({ id: 3, checkBoxes: [{ id: 10, data: 'Old', done: false, indentLevel: 0 }] }),
    updateNote: async (_id, next) => { changes = next; return next; }
  }), async client => {
    const result = await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId: 3, action: 'update', itemId: 10, text: 'New', done: true } });
    assert.equal(result.isError, undefined);
  });
  assert.deepEqual(changes.checkBoxes, [{ id: 10, data: 'New', done: true, indentLevel: 0 }]);
  assert.equal(changes.isCbox, true);
});

test('owner-only organization fields are checked before update', async () => {
  let ownerChecks = 0;
  let updates = 0;
  await withMcpClient(stubKeptClient({
    assertNoteOwner: async () => { ownerChecks += 1; throw new Error('Only the note owner can change organization.'); },
    updateNote: async () => { updates += 1; }
  }), async client => {
    const result = await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, binder: 'Private' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Only the note owner/);
  });
  assert.equal(ownerChecks, 1);
  assert.equal(updates, 0);
});

test('locked checklist content is not overwritten before browser unlock', async () => {
  await withMcpClient(stubKeptClient({ getNote: async () => ({ id: 3, locked: true, lockedContentAvailable: false }) }), async client => {
    const result = await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId: 3, action: 'add', text: 'Nope' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unlock this note/);
  });
});

test('attachment reads return an embedded binary resource', async () => {
  await withMcpClient(stubKeptClient(), async client => {
    const result = await client.callTool({ name: 'kept_read_attachment', arguments: { attachmentId: 4 } });
    assert.equal(result.content[0].type, 'resource');
    assert.equal(result.content[0].resource.mimeType, 'text/plain');
    assert.equal(Buffer.from(result.content[0].resource.blob, 'base64').toString(), 'hello');
  });
});

test('image and attachment tools accept ChatGPT file params', async () => {
  const uploaded = [];
  await withMcpClient(stubKeptClient({
    uploadImage: async file => {
      uploaded.push({ type: 'image', ...file });
      return { url: '/api/uploads/images/photo.png', name: file.filename };
    },
    uploadAttachment: async (noteId, file) => {
      uploaded.push({ type: 'attachment', noteId, ...file });
      return { id: 9, noteId, originalName: file.filename };
    }
  }), async client => {
    const image = await client.callTool({ name: 'kept_add_image', arguments: {
      noteId: 3,
      file: { download_url: 'https://files.example/photo.png', file_id: 'file_1', mime_type: 'image/png', file_name: 'photo.png' }
    } });
    const attachment = await client.callTool({ name: 'kept_upload_attachment', arguments: {
      noteId: 3,
      file: { download_url: 'https://files.example/report.pdf', file_id: 'file_2', mime_type: 'application/pdf', file_name: 'report.pdf' }
    } });
    assert.equal(image.isError, undefined);
    assert.equal(attachment.isError, undefined);
  });
  assert.equal(uploaded[0].type, 'image');
  assert.equal(uploaded[0].filename, 'photo.png');
  assert.equal(uploaded[1].type, 'attachment');
  assert.equal(uploaded[1].filename, 'report.pdf');
});

test('delete image removes one image by id and preserves the rest', async () => {
  let changes;
  await withMcpClient(stubKeptClient({
    getNote: async () => ({
      id: 3,
      images: [
        { id: 'keep', dataUrl: '/api/uploads/images/keep.png' },
        { id: 'remove-me', dataUrl: '/api/uploads/images/remove.png' }
      ]
    }),
    updateNote: async (_id, next) => { changes = next; return next; }
  }), async client => {
    const result = await client.callTool({ name: 'kept_delete_image', arguments: { noteId: 3, imageId: 'remove-me' } });
    assert.equal(result.isError, undefined);
  });
  assert.deepEqual(changes.images, [{ id: 'keep', dataUrl: '/api/uploads/images/keep.png' }]);
});

test('delete image requires an existing image and unlocked content', async () => {
  await withMcpClient(stubKeptClient({ getNote: async () => ({ id: 3, images: [{ id: 'one' }] }) }), async client => {
    const result = await client.callTool({ name: 'kept_delete_image', arguments: { noteId: 3, imageId: 'missing' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Image not found/);
  });
  await withMcpClient(stubKeptClient({ getNote: async () => ({ id: 3, locked: true, lockedContentAvailable: false, images: [{ id: 'one' }] }) }), async client => {
    const result = await client.callTool({ name: 'kept_delete_image', arguments: { noteId: 3, imageId: 'one' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unlock this note/);
  });
});

test('API failures become MCP tool errors without stopping the server', async () => {
  await withMcpClient(stubKeptClient({ getNote: async () => { throw new Error('Note not found.'); } }), async client => {
    const failed = await client.callTool({ name: 'kept_get_note', arguments: { noteId: 404 } });
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0].text, 'Note not found.');
    assert.equal((await client.callTool({ name: 'kept_list_labels', arguments: {} })).isError, undefined);
  });
});

test('excessive input collections are rejected before tool validation or execution', async () => {
  let writes = 0;
  await withMcpClient(stubKeptClient({ createNote: async () => { writes++; } }), async client => {
    const result = await client.callTool({ name: 'kept_create_note', arguments: {
      checklist: Array.from({ length: 10_001 }, () => ({ text: 'item' }))
    } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /maximum of 10000 elements/);
    assert.equal(writes, 0);
    assert.equal((await client.callTool({ name: 'kept_list_labels', arguments: {} })).isError, undefined);
  });
});

test('the largest supported checklist and normal labels still pass the input budget', async () => {
  let note;
  await withMcpClient(stubKeptClient({ createNote: async value => { note = value; return { id: 1 }; } }), async client => {
    const result = await client.callTool({ name: 'kept_create_note', arguments: {
      checklist: Array.from({ length: 500 }, () => ({ text: 'item', done: false, indentLevel: 0, format: 'plain_text' })),
      labels: Array.from({ length: 50 }, (_, index) => `label ${index}`)
    } });
    assert.equal(result.isError, undefined);
    assert.equal(note.checkBoxes.length, 500);
    assert.equal(note.labels.length, 50);
  });
});

test('read-only OAuth tokens cannot start downloads or other write-tool side effects', async () => {
  let downloaded = false;
  await withMcpClient(stubKeptClient({fileParamToUpload:async()=>{downloaded=true;throw new Error('must not download');}}), async client => {
    const result=await client.callTool({name:'kept_upload_attachment',arguments:{noteId:3,file:{download_url:'https://files.example/file.txt',file_id:'file-1',mime_type:'text/plain',file_name:'file.txt'}}});
    assert.equal(result.isError,true);assert.match(result.content[0].text,/kept.write/);assert.equal(downloaded,false);
    assert.equal((await client.callTool({name:'kept_get_note',arguments:{noteId:3}})).isError,undefined);
  }, {oauth:true,scopes:['kept.read']});
});

test('appearance catalogue exposes the actual UI choices without SVG payloads, also to read-only clients', async () => {
  await withMcpClient(stubKeptClient(), async client => {
    const result = await client.callTool({ name: 'kept_get_appearance_options', arguments: {} });
    assert.equal(result.isError, undefined);
    const options = result.structuredContent.result;
    assert.deepEqual(options.colors.map(item => item.color), palette.families.flatMap(family => family.colors.map(key => palette.colors[key])));
    assert.equal(options.colors.length, 54);
    assert.equal(options.colors[0].color, '', 'Default follows the theme');
    assert.equal(options.backgrounds.length, 13);
    assert.equal(options.backgrounds[0].backgroundImage, '');
    assert.deepEqual(options.patterns, appearance.patterns.map(({ id, name }) => ({ name, pattern: id })));
    assert.equal(options.patterns.length, 27);
    assert.match(options.highlight.example, /<mark class="hl">/);
    assert.doesNotMatch(JSON.stringify(options), /<svg/);
  }, { oauth: true, scopes: ['kept.read'] });
});

test('patterns can be selected and cleared; illustrations and unrelated fields behave like the UI', async () => {
  const changes = [];
  await withMcpClient(stubKeptClient({ updateNote: async (_id, next) => { changes.push(next); return next; } }), async client => {
    for (const { id } of appearance.patterns) {
      const result = await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, pattern: id, color: '#1a4a4a' } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(changes.at(-1), { pattern: id, bgColor: '#1a4a4a', bgImage: '' });
    }
    await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, pattern: null } });
    assert.deepEqual(changes.at(-1), { pattern: null });
    await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, backgroundImage: '/assets/images/backgrounds/travel.svg' } });
    assert.deepEqual(changes.at(-1), { bgImage: 'url(/assets/images/backgrounds/travel.svg)', pattern: null });
    await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, title: 'Only title' } });
    assert.deepEqual(changes.at(-1), { noteTitle: 'Only title' });
    const count = changes.length;
    for (const args of [{ pattern: 'unknown' }, { pattern: 'travel', backgroundImage: 'url(/assets/images/backgrounds/budget.svg)' }]) {
      assert.equal((await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, ...args } })).isError, true);
    }
    assert.equal(changes.length, count);
  });
});

test('rich HTML preserves highlights, inline images, formatting and list anchors while stripping active content', async () => {
  let note;
  const html = '<p><mark class="hl" onclick="bad()">Important</mark><sup>2</sup></p>' +
    '<div class="kept-checklist-anchor kept-list-packing"></div>' +
    '<table><tr><td>Keep table</td></tr></table><img src="/api/uploads/images/photo.jpg" alt="Photo" onerror="bad()" />' +
    '<script>bad()</script><img src="data:image/svg+xml;base64,PHN2Zz4=" /><a href="javascript:bad()">unsafe</a>' +
    '<span style="color:red;background-image:url(https://evil.test/x)">Styled</span>';
  await withMcpClient(stubKeptClient({ updateNote: async (_id, next) => { note = next; return next; } }), async client => {
    assert.equal((await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, body: html, format: 'html' } })).isError, undefined);
    assert.match(note.noteBody, /<mark class="hl">Important<\/mark>/);
    assert.match(note.noteBody, /kept-checklist-anchor kept-list-packing/);
    assert.match(note.noteBody, /<sup>2<\/sup>/);
    assert.match(note.noteBody, /<table>/);
    assert.match(note.noteBody, /src="\/api\/uploads\/images\/photo.jpg"/);
    assert.match(note.noteBody, /style="color:red"/);
    assert.doesNotMatch(note.noteBody, /onerror|onclick|<script|javascript:|image\/svg|background-image/);
    assert.equal('checkBoxes' in note, false, 'body-only edits preserve existing rows');
  });
});

test('content blocks create ordered lists with rich text and stable IDs, and can replace or clear content', async () => {
  let note;
  await withMcpClient(stubKeptClient({ createNote: async next => { note = next; return { id: 3, ...next }; }, updateNote: async (_id, next) => { note = next; return next; } }), async client => {
    const result = await client.callTool({ name: 'kept_create_note', arguments: { pattern: 'lemons', color: '#fff8b8', contentBlocks: [
      { type: 'text', text: '<h2>Ingredients</h2>', format: 'html' },
      { type: 'checklist', id: 'ingredients', items: [{ id: 10, text: '<mark class="hl">Lemons</mark>', format: 'html', done: true }, { text: 'Sugar', indentLevel: 1 }] },
      { type: 'text', text: 'Then prepare' },
      { type: 'checklist', id: 'steps', items: [{ id: 20, text: 'Mix' }] },
      { type: 'text', text: '<p>Enjoy</p><img src="/api/uploads/images/lemon.jpg">', format: 'html' }
    ] } });
    assert.equal(result.isError, undefined);
    assert.equal(note.pattern, 'lemons');
    assert.equal(note.isCbox, true);
    assert.equal(note.noteBody, '<h2>Ingredients</h2><div class="kept-checklist-anchor kept-list-ingredients"></div>Then prepare<div class="kept-checklist-anchor kept-list-steps"></div><p>Enjoy</p><img src="/api/uploads/images/lemon.jpg" />');
    assert.equal(note.checkBoxes[0].id, 10);
    assert.equal(note.checkBoxes[0].data, '<mark class="hl">Lemons</mark>');
    assert.equal(note.checkBoxes[0].done, true);
    assert.equal(note.checkBoxes[1].listId, 'ingredients');
    assert.equal(note.checkBoxes[1].indentLevel, 1);
    assert.equal(new Set(note.checkBoxes.map(item => item.id)).size, 3);
    assert.equal(note.checkBoxes[2].id, 20);
    assert.equal(note.checkBoxes[2].listId, 'steps');
    await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, contentBlocks: [{ type: 'text', text: 'Now plain' }] } });
    assert.deepEqual(note, { noteBody: 'Now plain', isCbox: false, checkBoxes: [] });
    await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, contentBlocks: [] } });
    assert.deepEqual(note, { noteBody: '', isCbox: false, checkBoxes: [] });
  });
});

test('ambiguous or oversized block content fails before uploads, label resolution or writes', async () => {
  let sideEffects = 0;
  const effect = async () => { sideEffects++; };
  await withMcpClient(stubKeptClient({ createNote: effect, updateNote: effect, resolveLabels: effect, uploadImage: effect }), async client => {
    const list = id => ({ type: 'checklist', id, items: [{ text: 'Item', id: 10 }] });
    for (const args of [
      { body: 'Ambiguous', contentBlocks: [] },
      { checklist: [], contentBlocks: [] },
      { contentBlocks: [list('one'), list('one')] },
      { contentBlocks: [list('one'), list('two')] },
      { contentBlocks: [{ type: 'text', text: '<div class="kept-checklist-anchor"></div>', format: 'html' }] },
      { contentBlocks: [{ type: 'checklist', id: 'one', items: Array.from({ length: 500 }, () => ({ text: 'item' })) }, { type: 'checklist', id: 'two', items: [{ text: 'over limit' }] }] },
      { contentBlocks: [{ type: 'text', text: 'x'.repeat(300_000) }, { type: 'text', text: 'y'.repeat(300_000) }] },
      { pattern: 'travel', backgroundImage: 'url(/assets/images/backgrounds/cafes.svg)' }
    ]) {
      const result = await client.callTool({ name: 'kept_create_note', arguments: { title: 'Invalid', labels: ['no-side-effect'], drawingPngBase64: 'eA==', ...args } });
      assert.equal(result.isError, true);
    }
    assert.equal(sideEffects, 0);
  });
});

test('checklist edits target the right block, preserve other content, and allow moves between lists', async () => {
  let note = { id: 3, noteBody: '<p>Before</p><div class="kept-checklist-anchor kept-list-a"></div><p>Middle</p><div class="kept-checklist-anchor kept-list-b"></div><p>After</p>', checkBoxes: [
    { id: 10, listId: 'a', data: '<mark class="hl">Keep</mark>', done: false, indentLevel: 0 },
    { id: 20, listId: 'b', data: 'Other', done: true, indentLevel: 1 }
  ] };
  const originalBody = note.noteBody;
  await withMcpClient(stubKeptClient({ getNote: async () => note, updateNote: async (_id, next) => { note = { ...note, ...next }; return note; } }), async client => {
    assert.equal((await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId: 3, action: 'add', text: 'Ambiguous' } })).isError, true);
    assert.equal(note.checkBoxes.length, 2);
    await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId: 3, action: 'add', listId: 'b', text: 'Next' } });
    assert.equal(note.checkBoxes.at(-1).listId, 'b');
    await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId: 3, action: 'move', itemId: 10, listId: 'b', beforeItemId: 20 } });
    assert.equal(note.checkBoxes[0].id, 10);
    assert.equal(note.checkBoxes[0].listId, 'b');
    assert.equal(note.checkBoxes[0].data, '<mark class="hl">Keep</mark>');
    assert.equal(note.noteBody, originalBody);
    assert.equal((await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId: 3, action: 'move', itemId: 10, listId: 'a', beforeItemId: 20 } })).isError, true);
    await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId: 3, action: 'move', itemId: 20, listId: 'c' } });
    assert.equal(note.checkBoxes.find(item => item.id === 20).listId, 'c');
    assert.equal(note.noteBody, originalBody + '<div class="kept-checklist-anchor kept-list-c"></div>');
  });
});

test('adding a new block to a legacy list retains its original position; a single named list needs no explicit target', async () => {
  let note = { id: 3, noteBody: '<p>Intro</p>', checkBoxes: [{ id: 10, data: 'Legacy', done: false }] };
  await withMcpClient(stubKeptClient({ getNote: async () => note, updateNote: async (_id, next) => { note = { ...note, ...next }; return note; } }), async client => {
    await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId: 3, action: 'add', listId: 'new', text: 'New' } });
    assert.equal(note.noteBody, '<p>Intro</p><div class="kept-checklist-anchor"></div><div class="kept-checklist-anchor kept-list-new"></div>');
    note = { id: 3, noteBody: '<p>Intro</p>', checkBoxes: [{ id: 10, listId: 'single', data: 'Only' }] };
    await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId: 3, action: 'add', text: 'Next' } });
    assert.equal(note.checkBoxes.at(-1).listId, 'single');
  });
});

test('collaborators can edit appearance without an owner check; organization still requires ownership', async () => {
  let changes;
  await withMcpClient(stubKeptClient({ assertNoteOwner: async () => { throw new Error('Owner required'); }, updateNote: async (_id, next) => { changes = next; return next; } }), async client => {
    assert.equal((await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, color: '#1a4a4a', pattern: 'travel' } })).isError, undefined);
    assert.deepEqual(changes, { bgColor: '#1a4a4a', bgImage: '', pattern: 'travel' });
    assert.equal((await client.callTool({ name: 'kept_update_note', arguments: { noteId: 3, labels: ['Owner only'] } })).isError, true);
  });
});

test('real MCP tools persist and round-trip rich multi-list notes, shared appearance and permissions', { timeout: 30_000 }, async () => {
  const fixture = await startFixture();
  try {
    const api = async (path, { body, method = body ? 'POST' : 'GET', token, expected = 200 } = {}) => {
      const response = await fetch(fixture.origin + '/api' + path, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const result = response.status === 204 ? null : await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    };
    const owner = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
    const friend = { username: 'friend', displayName: 'Friend', password: 'test-password-456' };
    await api('/setup/admin', { body: owner, expected: 201 });
    const ownerLogin = await api('/auth/login', { body: owner });
    const person = await api('/users', { body: friend, token: ownerLogin.token, expected: 201 });
    const friendLogin = await api('/auth/login', { body: friend });
    const ownerAccess = await api('/users/me/mcp-access/enable', { body: {}, token: ownerLogin.token, expected: 201 });
    const friendAccess = await api('/users/me/mcp-access/enable', { body: {}, token: friendLogin.token, expected: 201 });
    const adapter = token => new KeptClient({ baseUrl: fixture.origin, token, timeoutMs: 10_000, customHeaders: {} });
    let noteId;
    await withMcpClient(adapter(ownerAccess.accessToken), async client => {
      const result = await client.callTool({ name: 'kept_create_note', arguments: {
        title: 'Lemon picnic', color: '#fff8b8', pattern: 'lemons', contentBlocks: [
          { type: 'text', text: '<p>Meet <mark class="hl">Saturday</mark>.</p>', format: 'html' },
          { type: 'checklist', id: 'packing', items: [{ text: 'Blanket' }, { text: 'Cups', indentLevel: 1, done: true }] },
          { type: 'text', text: 'Before we leave' },
          { type: 'checklist', id: 'errands', items: [{ text: 'Buy lemons' }] },
          { type: 'text', text: 'See you there' }
        ]
      } });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      noteId = result.structuredContent.result.id;
      let note = (await client.callTool({ name: 'kept_get_note', arguments: { noteId } })).structuredContent.result;
      assert.equal(note.pattern, 'lemons');
      assert.equal(note.isCbox, true);
      assert.deepEqual(note.checkBoxes.map(item => item.listId), ['packing', 'packing', 'errands']);
      assert.equal(note.checkBoxes[1].done, true);
      const body = note.noteBody, ids = note.checkBoxes.map(item => item.id);
      assert.match(body, /<mark class="hl">Saturday<\/mark>/);
      assert.ok(body.indexOf('kept-list-packing') < body.indexOf('Before we leave'));
      assert.ok(body.indexOf('Before we leave') < body.indexOf('kept-list-errands'));
      assert.ok(body.indexOf('kept-list-errands') < body.indexOf('See you there'));
      const uploaded = await client.callTool({ name: 'kept_add_image', arguments: { noteId, mimeType: 'image/png', name: 'picnic.png', base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=' } });
      assert.equal(uploaded.isError, undefined, JSON.stringify(uploaded));
      const image = uploaded.structuredContent.result.images[0];
      const richBody = body + `<p><img src="${image.dataUrl}" alt="Picnic" /></p>`;
      assert.equal((await client.callTool({ name: 'kept_update_note', arguments: { noteId, body: richBody, format: 'html' } })).isError, undefined);
      assert.equal((await client.callTool({ name: 'kept_update_note', arguments: { noteId, title: 'Saturday picnic' } })).isError, undefined);
      assert.equal((await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId, action: 'update', itemId: ids[0], done: true } })).isError, undefined);
      assert.equal((await client.callTool({ name: 'kept_manage_checklist', arguments: { noteId, action: 'add', listId: 'errands', text: 'Buy ice' } })).isError, undefined);
      note = (await client.callTool({ name: 'kept_get_note', arguments: { noteId } })).structuredContent.result;
      assert.equal(note.noteBody, richBody);
      assert.equal(note.images[0].dataUrl, image.dataUrl);
      assert.deepEqual(note.checkBoxes.slice(0, 3).map(item => item.id), ids);
      assert.equal(note.checkBoxes[0].done, true);
      assert.equal(note.checkBoxes.at(-1).listId, 'errands');
    });
    // A user without access cannot change content or appearance.
    await withMcpClient(adapter(friendAccess.accessToken), async client => {
      assert.equal((await client.callTool({ name: 'kept_update_note', arguments: { noteId, pattern: 'hearts' } })).isError, true);
    });
    await api(`/notes/${noteId}/collaborators`, { body: { userIds: [person.id] }, method: 'PUT', token: ownerLogin.token });
    await withMcpClient(adapter(friendAccess.accessToken), async client => {
      const call = async args => client.callTool({ name: 'kept_update_note', arguments: { noteId, ...args } });
      assert.equal((await call({ pattern: 'hearts', color: '#fdcfe8' })).isError, undefined);
      assert.equal((await call({ binder: 'Private binder' })).isError, true);
      assert.equal((await call({ backgroundImage: '/assets/images/backgrounds/romantic.svg' })).isError, undefined);
    });
    const after = await api(`/notes/${noteId}`, { token: ownerLogin.token });
    assert.equal(after.pattern, null);
    assert.equal(after.bgColor, '#fdcfe8');
    assert.equal(after.bgImage, 'url(/assets/images/backgrounds/romantic.svg)');
    assert.match(after.noteBody, /<mark class="hl">Saturday<\/mark>/);
    assert.equal(after.checkBoxes.length, 4);
    const cards = await api('/notes?view=card', { token: ownerLogin.token });
    assert.equal(cards.notes.find(note => note.id === noteId).bgImage, after.bgImage);
  } finally { await fixture.close(); }
});
