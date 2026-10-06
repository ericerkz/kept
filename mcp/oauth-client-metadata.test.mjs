import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trustedClientMetadataDocument } = require('../server/oauth-mcp.js');

test('client ID metadata documents are trusted for ChatGPT and Claude', () => {
  assert.equal(trustedClientMetadataDocument('https://chatgpt.com/oauth/client.json')?.clientName, 'ChatGPT');
  assert.equal(trustedClientMetadataDocument('https://chatgpt.com/oauth/abc123/client.json')?.clientName, 'ChatGPT');
  const claude = trustedClientMetadataDocument('https://claude.ai/oauth/mcp-oauth-client-metadata');
  assert.equal(claude?.clientName, 'Claude');
  assert.equal(claude?.metadataUrl.href, 'https://claude.ai/oauth/mcp-oauth-client-metadata');
});

test('client ID metadata documents from other URLs are not fetched', () => {
  for (const clientId of [
    'kept_client_abc',
    'not a url',
    'http://claude.ai/oauth/mcp-oauth-client-metadata',
    'https://claude.ai/oauth/other-client',
    'https://claude.ai/oauth/mcp-oauth-client-metadata?x=1',
    'https://claude.ai/oauth/mcp-oauth-client-metadata#fragment',
    'https://user@claude.ai/oauth/mcp-oauth-client-metadata',
    'https://claude.ai.example.com/oauth/mcp-oauth-client-metadata',
    'https://chatgpt.com/oauth/client.json.example',
    'https://example.com/oauth/client.json'
  ]) {
    assert.equal(trustedClientMetadataDocument(clientId), null, clientId);
  }
});
