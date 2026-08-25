#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KeptClient, loadKeptConfig } from './kept-client.mjs';
import { createKeptMcpServer } from './server.mjs';

async function main() {
  const client = new KeptClient(loadKeptConfig());
  const server = createKeptMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(`Kept MCP failed to start: ${error instanceof Error ? error.message : 'Unknown error.'}`);
  process.exitCode = 1;
});
