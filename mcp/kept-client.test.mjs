import assert from 'node:assert/strict';
import test from 'node:test';
import { KeptApiError, KeptClient, loadKeptConfig } from './kept-client.mjs';

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('loadKeptConfig requires a dedicated MCP token and validates optional headers', () => {
  assert.throws(() => loadKeptConfig({}), /KEPT_BASE_URL is required/);
  assert.throws(() => loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com' }), /KEPT_MCP_TOKEN is required/);
  assert.throws(() => loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com', KEPT_MCP_TOKEN: 'kept_mcp_test', KEPT_CUSTOM_HEADERS_JSON: '{bad json' }), /valid JSON/);
  assert.throws(() => loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com', KEPT_MCP_TOKEN: 'kept_mcp_test', KEPT_CUSTOM_HEADERS_JSON: '{"Authorization":"nope"}' }), /not allowed/);
  assert.deepEqual(loadKeptConfig({
    KEPT_BASE_URL: 'https://kept.example.com/', KEPT_MCP_TOKEN: 'kept_mcp_test', KEPT_REQUEST_TIMEOUT_MS: '2500',
    KEPT_CUSTOM_HEADERS_JSON: '{"CF-Access-Client-Id":"client-id"}'
  }), { baseUrl: 'https://kept.example.com', token: 'kept_mcp_test', timeoutMs: 2500, customHeaders: { 'CF-Access-Client-Id': 'client-id' } });
});

test('requests use bearer and custom headers without putting secrets in the URL', async () => {
  const calls = [];
  const client = new KeptClient(loadKeptConfig({
    KEPT_BASE_URL: 'https://kept.example.com', KEPT_MCP_TOKEN: 'kept_mcp_secret-token',
    KEPT_CUSTOM_HEADERS_JSON: '{"X-Proxy-Secret":"gateway-secret"}'
  }), { fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse([{ id: 7, noteTitle: 'Result' }]); } });
  assert.deepEqual(await client.searchNotes('project plan'), [{ id: 7, noteTitle: 'Result' }]);
  assert.equal(calls[0].url, 'https://kept.example.com/api/notes/search?q=project%20plan');
  assert.equal(calls[0].options.headers.authorization, 'Bearer kept_mcp_secret-token');
  assert.equal(calls[0].options.headers['X-Proxy-Secret'], 'gateway-secret');
  assert.equal(calls[0].url.includes('secret'), false);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('redirects are refused instead of forwarding credentials', async () => {
  const client = new KeptClient(loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com', KEPT_MCP_TOKEN: 'kept_mcp_test' }), {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } })
  });
  await assert.rejects(() => client.getNote(1), error => error instanceof KeptApiError && error.code === 'REDIRECT_BLOCKED');
});

test('resolveLabels deduplicates names and creates only missing labels', async () => {
  const calls = [];
  const responses = [jsonResponse([{ id: 2, name: 'Work' }]), jsonResponse({ id: 5, name: 'Agent' })];
  const client = new KeptClient(loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com', KEPT_MCP_TOKEN: 'kept_mcp_test' }), {
    fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); }
  });
  assert.deepEqual(await client.resolveLabels(['work', 'WORK', 'Agent']), [
    { id: 2, name: 'Work', added: true }, { id: 5, name: 'Agent', added: true }
  ]);
  assert.equal(new URL(calls[1].url).pathname, '/api/labels/find-or-create');
  assert.equal(calls[1].options.body, JSON.stringify({ name: 'Agent' }));
});

test('updateNote patches selected fields and returns the current note', async () => {
  const calls = [];
  const client = new KeptClient(loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com', KEPT_MCP_TOKEN: 'kept_mcp_test' }), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return options.method === 'PATCH' ? new Response(null, { status: 204 }) : jsonResponse({ id: 9, noteTitle: 'Updated' });
    }
  });
  assert.equal((await client.updateNote(9, { noteTitle: 'Updated' })).noteTitle, 'Updated');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.body, JSON.stringify({ noteTitle: 'Updated' }));
  assert.equal(calls[1].options.method, 'GET');
});

test('owner-only actions reject collaborators before mutation', async () => {
  const calls = [];
  const client = new KeptClient(loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com', KEPT_MCP_TOKEN: 'kept_mcp_test' }), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (new URL(url).pathname === '/api/mcp/status') return jsonResponse({ userId: 4 });
      return jsonResponse({ id: 8, ownerUserId: 7 });
    }
  });
  await assert.rejects(() => client.setLifecycle(8, 'trash'), /Only the note owner/);
  assert.equal(calls.some(call => call.options.method === 'PATCH'), false);
});
