import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for Kept test server.')), 10000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('Keep API listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      if (text.trim()) process.stderr.write(text);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Kept test server exited early with code ${code}.`));
    });
  });
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

test('remote MCP OAuth flow issues a usable Streamable HTTP token', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kept-oauth-'));
  const port = 32000 + Math.floor(Math.random() * 1000);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SQLITE_PATH: join(directory, 'kept.sqlite'), BASE_URL: origin },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  });
  await waitForServer(child);

  const metadata = await json(`${origin}/.well-known/oauth-authorization-server`);
  assert.equal(metadata.token_endpoint, `${origin}/oauth/token`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);

  await json(`${origin}/api/setup/admin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'oauth-test', displayName: 'OAuth test', password: 'testing123' })
  });
  const login = await json(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'oauth-test', password: 'testing123' })
  });
  await json(`${origin}/api/users/me/mcp-access/enable`, {
    method: 'POST', headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' }, body: '{}'
  });

  const client = await json(`${origin}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test client', redirect_uris: ['http://localhost:9876/callback'], token_endpoint_auth_method: 'none' })
  });
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${origin}/oauth/authorize`);
  Object.entries({
    client_id: client.client_id, redirect_uri: 'http://localhost:9876/callback',
    response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'kept.read kept.write', resource: `${origin}/mcp`, state: 'test-state'
  }).forEach(([key, value]) => authorize.searchParams.set(key, value));
  const authorizeResponse = await fetch(authorize);
  assert.ok(authorizeResponse.ok);
  const page = await authorizeResponse.text();
  const request = page.match(/const requestId="([^"]+)"/)?.[1];
  assert.ok(request);

  const approval = await json(`${origin}/oauth/authorize/approve`, {
    method: 'POST', headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request })
  });
  const code = new URL(approval.redirect).searchParams.get('code');
  assert.ok(code);

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code', client_id: client.client_id, code,
    redirect_uri: 'http://localhost:9876/callback', code_verifier: verifier, resource: `${origin}/mcp`
  });
  const tokens = await json(`${origin}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenBody
  });
  assert.match(tokens.access_token, /^kept_oauth_/);
  assert.match(tokens.refresh_token, /^kept_refresh_/);

  const mcpResponse = await json(`${origin}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  });
  assert.equal(mcpResponse.result.serverInfo.name, 'kept-mcp');
  const tools = await json(`${origin}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  });
  assert.equal(tools.result.tools.length, 22);
  assert.deepEqual(tools.result.tools[0]._meta.securitySchemes, [{ type: 'oauth2', scopes: ['kept.read', 'kept.write'] }]);

  const refreshed = await json(`${origin}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token })
  });
  assert.match(refreshed.access_token, /^kept_oauth_/);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

  await fetch(`${origin}/oauth/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshed.access_token, client_id: client.client_id })
  });
  const revoked = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${refreshed.access_token}`, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(revoked.status, 401);

  const unauthorized = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate') || '', /oauth-protected-resource/);
});
