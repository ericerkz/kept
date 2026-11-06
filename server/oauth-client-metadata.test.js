const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const express = require('express');
const sqlite3 = require('sqlite3');
const { initOAuthTables, mountOAuthAndMcpRoutes } = require('./oauth-mcp');
const { createClientMetadataResolver } = require('./oauth-client-metadata');
const { createRequestLimits } = require('./request-limits');

async function fixture(t, { limit = 120 } = {}) {
  const db = new sqlite3.Database(':memory:');
  const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
    error ? reject(error) : resolve({ changes: this.changes, lastID: this.lastID });
  }));
  await run('CREATE TABLE users (id INTEGER PRIMARY KEY, enabled INTEGER, oauthEnabled INTEGER)');
  await run('INSERT INTO users VALUES (1, 1, 1)');
  await run('CREATE TABLE external_unlock_challenges (principalType TEXT, principalId INTEGER)');
  await initOAuthTables({ run, all });
  const calls = [], documents = new Map();
  const resolveClient = createClientMetadataResolver({ download: async (id, options) => {
    calls.push({ id, options });
    const metadata = documents.get(id);
    if (!metadata) throw new Error('Metadata unavailable');
    return { body: Buffer.from(JSON.stringify(metadata)), headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } };
  } });
  const app = express();
  app.use(express.json());
  const next = (_req, _res, next) => next();
  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  mountOAuthAndMcpRoutes(app, {
    get, all, run, asyncRoute, resolveClient,
    requireAuth: (req, _res, next) => { req.user = { id: 1, oauthEnabled: true }; next(); },
    browserSessions: { protect: next }, registerLimiter: next, oauthRegistrationLimiter: next, oauthTokenLimiter: next,
    oauthAuthorizationLimiter: createRequestLimits().rateLimit({ windowMs: 60000, max: limit, key: 'test-authorize' }),
    withDatabaseTransaction: async fn => {
      await run('BEGIN');
      try { const result = await fn(); await run('COMMIT'); return result; }
      catch (error) { await run('ROLLBACK'); throw error; }
    }
  });
  app.use((error, _req, res, _next) => { res.status(500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const metadata = (id, changes = {}) => ({ client_id: id, client_name: 'Test client', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', ...changes });
  const authorize = async (id, redirect = 'http://127.0.0.1:19876/callback') => {
    const verifier = randomBytes(48).toString('base64url');
    const params = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code',
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      scope: 'kept.read kept.write', resource: `${origin}/mcp`, state: 'kept-test-state' });
    const response = await fetch(`${origin}/oauth/authorize?${params}`, { redirect: 'manual' });
    const page = await response.text();
    return { response, page, request: page.match(/const requestId="([^"]+)"/)?.[1], verifier, redirect };
  };
  const post = (path, body, form = false) => fetch(origin + path, { method: 'POST',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(body) : JSON.stringify(body) });
  return { origin, documents, calls, metadata, authorize, post, get };
}

test('OpenCode, ChatGPT, Claude and dynamic clients complete authorization, token exchange and refresh', async t => {
  const h = await fixture(t);
  const discovery = await (await fetch(`${h.origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(discovery.client_id_metadata_document_supported, true);
  for (const [id, name, redirects, requested, authentication = {}] of [
    ['https://opencode.ai/oauth/opencode/client.json', 'OpenCode', ['http://127.0.0.1/mcp/oauth/callback'], 'http://127.0.0.1:19876/mcp/oauth/callback'],
    ['https://chatgpt.com/oauth/client.json', 'ChatGPT', ['https://chatgpt.com/connector_platform_oauth_redirect'], 'https://chatgpt.com/connector_platform_oauth_redirect',
      { token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] }],
    ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude', ['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback']
  ]) {
    h.documents.set(id, h.metadata(id, { client_name: name, redirect_uris: redirects, ...authentication }));
    await complete(id, requested, new URL(id).hostname);
  }
  const registered = await h.post('/oauth/register', { client_name: 'Dynamic client', redirect_uris: ['http://127.0.0.1/callback'] });
  assert.equal(registered.status, 201);
  const dynamic = await registered.json(), downloads = h.calls.length;
  await complete(dynamic.client_id, 'http://127.0.0.1:54321/callback');
  assert.equal(h.calls.length, downloads, 'dynamic registration does not trigger metadata requests');

  async function complete(id, redirect, domain) {
    const flow = await h.authorize(id, redirect);
    assert.equal(flow.response.status, 200, flow.page);
    assert.ok(flow.request);
    if (domain) assert.ok(flow.page.includes(`Client domain: <strong>${domain}</strong>`));
    const resume = await fetch(`${h.origin}/oauth/authorize/resume?request=${flow.request}`);
    assert.equal(resume.status, 200);
    const approve = await h.post('/oauth/authorize/approve', { request: flow.request });
    assert.equal(approve.status, 200, await approve.clone().text());
    const callback = new URL((await approve.json()).redirect);
    assert.equal(callback.searchParams.get('state'), 'kept-test-state');
    assert.equal(callback.port, new URL(redirect).port);
    const code = callback.searchParams.get('code');
    const wrongRedirect = new URL(redirect);
    wrongRedirect.pathname += '/wrong';
    const wrong = await h.post('/oauth/token', { grant_type: 'authorization_code', client_id: id, code,
      redirect_uri: wrongRedirect.href, code_verifier: flow.verifier }, true);
    assert.equal(wrong.status, 400, 'token exchange stays bound to the exact approved callback');
    const token = await h.post('/oauth/token', { grant_type: 'authorization_code', client_id: id, code,
      redirect_uri: redirect, code_verifier: flow.verifier, resource: `${h.origin}/mcp` }, true);
    assert.equal(token.status, 200, await token.clone().text());
    const tokens = await token.json(); assert.match(tokens.access_token, /^kept_oauth_/);
    const refresh = await h.post('/oauth/token', { grant_type: 'refresh_token', client_id: id, refresh_token: tokens.refresh_token }, true);
    assert.equal(refresh.status, 200, await refresh.clone().text());
    assert.notEqual((await refresh.json()).access_token, tokens.access_token);
  }
});

test('bad or changed metadata redirects never receive authorization codes, and client presentation is escaped', async t => {
  const h = await fixture(t), id = 'https://new-client.example/oauth/client.json';
  h.documents.set(id, h.metadata(id, { client_name: '<script>alert(1)</script>', logo_uri: 'https://127.0.0.1/private' }));
  const invalid = await h.authorize(id, 'https://attacker.example/callback');
  assert.equal(invalid.response.status, 400); assert.equal(invalid.response.headers.get('location'), null);
  const flow = await h.authorize(id);
  assert.equal(flow.response.status, 200);
  assert.match(flow.page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(flow.page, /<script>alert/);
  assert.ok(h.calls.every(call => call.id === id), 'logos and other document URLs are never fetched');
  h.documents.set(id, h.metadata(id, { redirect_uris: ['https://new-client.example/changed'] }));
  const resume = await fetch(`${h.origin}/oauth/authorize/resume?request=${flow.request}`);
  assert.equal(resume.status, 400);
  assert.equal((await h.post('/oauth/authorize/approve', { request: flow.request })).status, 400);
  assert.equal((await h.get('SELECT COUNT(*) AS count FROM oauth_authorization_codes')).count, 0);
});

test('authorization routes rate-limit requests before fetching metadata', async t => {
  const h = await fixture(t, { limit: 3 }), id = 'https://new-client.example/oauth/client.json';
  h.documents.set(id, h.metadata(id));
  for (let i = 0; i < 3; i++) assert.equal((await h.authorize(id)).response.status, 200);
  const blocked = await h.authorize(id);
  assert.equal(blocked.response.status, 429); assert.ok(blocked.response.headers.get('retry-after'));
  assert.equal(h.calls.length, 3);
});
