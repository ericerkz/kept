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
  try {
    await run(client);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

function stubKeptClient(overrides = {}) {
  return {
    searchNotes: async () => [],
    getNote: async (noteId) => ({ id: noteId, noteTitle: 'Note' }),
    listLabels: async () => [],
    resolveLabels: async (names) => names.map((name, index) => ({ id: index + 1, name, added: true })),
    createNote: async (note) => ({ id: 11, ...note }),
    updateNote: async (noteId, changes) => ({ id: noteId, ...changes }),
    archiveNote: async (noteId) => ({ ok: true, noteId, archived: true }),
    trashNote: async (noteId) => ({ ok: true, noteId, trashed: true }),
    ...overrides
  };
}

test('server advertises the focused Kept tool set and safety annotations', async () => {
  await withMcpClient(stubKeptClient(), async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'kept_archive_note',
        'kept_create_note',
        'kept_get_note',
        'kept_list_labels',
        'kept_search_notes',
        'kept_trash_note',
        'kept_update_note'
      ]
    );
    assert.equal(tools.find((tool) => tool.name === 'kept_search_notes').annotations.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'kept_trash_note').annotations.destructiveHint, true);
  });
});

test('create tool maps friendly MCP fields to the Kept REST payload', async () => {
  let received;
  await withMcpClient(
    stubKeptClient({
      createNote: async (note) => {
        received = note;
        return { id: 12, ...note };
      }
    }),
    async (client) => {
      const result = await client.callTool({
        name: 'kept_create_note',
        arguments: {
          title: 'Agent note',
          body: 'Captured through MCP',
          binder: 'Automation',
          labels: ['agent'],
          pinned: true
        }
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.result.id, 12);
    }
  );

  assert.deepEqual(received, {
    noteTitle: 'Agent note',
    noteBody: 'Captured through MCP',
    binder: 'Automation',
    labels: [{ id: 1, name: 'agent', added: true }],
    pinned: true
  });
});

test('write tools reject empty changes before calling Kept', async () => {
  let updateCalls = 0;
  await withMcpClient(
    stubKeptClient({
      updateNote: async () => {
        updateCalls += 1;
      }
    }),
    async (client) => {
      const createResult = await client.callTool({
        name: 'kept_create_note',
        arguments: { title: '  ', body: '  ' }
      });
      assert.equal(createResult.isError, true);
      assert.match(createResult.content[0].text, /title or body/i);

      const updateResult = await client.callTool({
        name: 'kept_update_note',
        arguments: { noteId: 3 }
      });
      assert.equal(updateResult.isError, true);
      assert.match(updateResult.content[0].text, /At least one note field/);
    }
  );
  assert.equal(updateCalls, 0);
});

test('API failures become MCP tool errors without terminating the server', async () => {
  await withMcpClient(
    stubKeptClient({
      getNote: async () => {
        throw new Error('Note not found.');
      }
    }),
    async (client) => {
      const failed = await client.callTool({ name: 'kept_get_note', arguments: { noteId: 404 } });
      assert.equal(failed.isError, true);
      assert.equal(failed.content[0].text, 'Note not found.');

      const labels = await client.callTool({ name: 'kept_list_labels', arguments: {} });
      assert.equal(labels.isError, undefined);
    }
  );
});
