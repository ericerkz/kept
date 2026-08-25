import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const noteIdSchema = z.number().int().positive().describe('Kept note id');
const titleSchema = z.string().max(500).describe('Plain-text note title');
const bodySchema = z.string().max(100_000).describe('Note body; plain text or trusted HTML supported by Kept');
const binderSchema = z.string().trim().max(80).describe('Optional Kept binder name');
const labelsSchema = z.array(z.string().trim().min(1).max(80)).max(50).describe('Kept label names');

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value }
  };
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : 'Unknown Kept MCP error.' }]
  };
}

function safely(handler) {
  return async (input) => {
    try {
      return await handler(input);
    } catch (error) {
      return toolError(error);
    }
  };
}

export function createKeptMcpServer(client) {
  const server = new McpServer({
    name: 'kept-mcp',
    version: '1.0.0'
  });

  server.registerTool(
    'kept_search_notes',
    {
      title: 'Search Kept notes',
      description: 'Search notes visible to the authenticated Kept user. Returns at most 20 summaries.',
      inputSchema: {
        query: z.string().trim().min(1).max(500).describe('Kept search query')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    safely(async ({ query }) => toolResult(await client.searchNotes(query)))
  );

  server.registerTool(
    'kept_get_note',
    {
      title: 'Get a Kept note',
      description: 'Get one note by id when it is visible to the authenticated Kept user.',
      inputSchema: { noteId: noteIdSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    safely(async ({ noteId }) => toolResult(await client.getNote(noteId)))
  );

  server.registerTool(
    'kept_list_labels',
    {
      title: 'List Kept labels',
      description: 'List labels owned by the authenticated Kept user.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    safely(async () => toolResult(await client.listLabels()))
  );

  server.registerTool(
    'kept_create_note',
    {
      title: 'Create a Kept note',
      description: 'Create a text note owned by the authenticated Kept user.',
      inputSchema: {
        title: titleSchema.optional().default(''),
        body: bodySchema.optional().default(''),
        binder: binderSchema.optional(),
        labels: labelsSchema.optional(),
        pinned: z.boolean().optional().describe('Pin the new note')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    safely(async ({ title, body, binder, labels, pinned }) => {
      if (!title.trim() && !body.trim()) {
        throw new Error('A title or body is required.');
      }
      const resolvedLabels = labels === undefined ? undefined : await client.resolveLabels(labels);
      const note = {
        noteTitle: title,
        noteBody: body,
        ...(binder === undefined ? {} : { binder }),
        ...(resolvedLabels === undefined ? {} : { labels: resolvedLabels }),
        ...(pinned === undefined ? {} : { pinned })
      };
      return toolResult(await client.createNote(note));
    })
  );

  server.registerTool(
    'kept_update_note',
    {
      title: 'Update a Kept note',
      description: 'Update selected fields on a note visible to the authenticated Kept user.',
      inputSchema: {
        noteId: noteIdSchema,
        title: titleSchema.optional(),
        body: bodySchema.optional(),
        binder: binderSchema.optional(),
        labels: labelsSchema.optional(),
        pinned: z.boolean().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    safely(async ({ noteId, title, body, binder, labels, pinned }) => {
      const resolvedLabels = labels === undefined ? undefined : await client.resolveLabels(labels);
      const changes = {
        ...(title === undefined ? {} : { noteTitle: title }),
        ...(body === undefined ? {} : { noteBody: body }),
        ...(binder === undefined ? {} : { binder }),
        ...(resolvedLabels === undefined ? {} : { labels: resolvedLabels }),
        ...(pinned === undefined ? {} : { pinned })
      };
      if (!Object.keys(changes).length) {
        throw new Error('At least one note field is required.');
      }
      return toolResult(await client.updateNote(noteId, changes));
    })
  );

  server.registerTool(
    'kept_archive_note',
    {
      title: 'Archive a Kept note',
      description: 'Archive a note owned by the authenticated Kept user.',
      inputSchema: { noteId: noteIdSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    safely(async ({ noteId }) => toolResult(await client.archiveNote(noteId)))
  );

  server.registerTool(
    'kept_trash_note',
    {
      title: 'Move a Kept note to trash',
      description: 'Move a note owned by the authenticated Kept user to trash. Kept retains trashed notes temporarily.',
      inputSchema: { noteId: noteIdSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    safely(async ({ noteId }) => toolResult(await client.trashNote(noteId)))
  );

  return server;
}
