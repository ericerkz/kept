import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKeptMcpServer } from './server.mjs';

async function withMcpClient(keptClient, run) {
  const server = createKeptMcpServer(keptClient);
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
    readImage: async () => ({ contentType: 'image/png', base64Data: Buffer.from('png').toString('base64') }),
    readAttachment: async () => ({ contentType: 'text/plain', base64Data: Buffer.from('hello').toString('base64') }),
    deleteAttachment: async (noteId, attachmentId) => ({ ok: true, noteId, attachmentId }), ...overrides
  };
}

const expectedTools = [
  'kept_add_image', 'kept_archive_note', 'kept_create_note', 'kept_delete_attachment', 'kept_delete_reminder',
  'kept_get_note', 'kept_list_labels', 'kept_list_reminders', 'kept_manage_checklist', 'kept_permanently_delete_note',
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

test('API failures become MCP tool errors without stopping the server', async () => {
  await withMcpClient(stubKeptClient({ getNote: async () => { throw new Error('Note not found.'); } }), async client => {
    const failed = await client.callTool({ name: 'kept_get_note', arguments: { noteId: 404 } });
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0].text, 'Note not found.');
    assert.equal((await client.callTool({ name: 'kept_list_labels', arguments: {} })).isError, undefined);
  });
});
