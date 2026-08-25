import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('stdio entrypoint completes an MCP handshake', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp/index.mjs'],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      KEPT_BASE_URL: 'https://kept.invalid',
      KEPT_TOKEN: 'stdio-test-token'
    }
  });
  const client = new Client({ name: 'kept-stdio-test', version: '1.0.0' });

  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    assert(tools.some((tool) => tool.name === 'kept_create_note'));
  } finally {
    await client.close();
  }
});
