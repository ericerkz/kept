import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { clientMetadataUrl, redirectUriMatches, parseClientMetadata, createClientMetadataResolver } = require('../server/oauth-client-metadata');
const { createPublicFileDownloader } = require('../server/public-file-download');
const get = async () => undefined;
const opencode = 'https://opencode.ai/oauth/opencode/client.json';
const document = (id = opencode, changes = {}) => ({ client_id: id, client_name: 'OpenCode',
  application_type: 'native', redirect_uris: ['http://127.0.0.1/callback', 'http://127.0.0.1/mcp/oauth/callback'],
  token_endpoint_auth_method: 'none', ...changes });
const jsonReply = (metadata, headers = {}) => ({ body: Buffer.from(JSON.stringify(metadata)), headers: { 'content-type': 'application/json', ...headers } });

function fixture({ replies = [], addresses = [{ address: '93.184.216.34', family: 4 }], now = Date.now } = {}) {
  const calls = [], lookups = [];
  const download = createPublicFileDownloader({
    lookup: async host => { lookups.push(host); return addresses; },
    request(url, options, callback) {
      calls.push({ url, options });
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        const reply = replies.shift() || { metadata: document(url.href) };
        const response = Readable.from(reply.chunks || [Buffer.from(reply.body ?? JSON.stringify(reply.metadata ?? {}))]);
        response.statusCode = reply.status || 200;
        response.headers = { 'content-type': 'application/json', ...reply.headers };
        options.signal.addEventListener('abort', () => response.destroy(options.signal.reason), { once: true });
        callback(response);
      });
      return req;
    }
  });
  return { resolve: createClientMetadataResolver({ download, now }), calls, lookups };
}

test('CIMD accepts providers without a special allowlist while rejecting malformed identifier URLs', () => {
  for (const id of [opencode, 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/oauth/abc123/client.json',
    'https://claude.ai/oauth/mcp-oauth-client-metadata', 'https://new-client.example/oauth/client.json?version=1']) {
    assert.ok(clientMetadataUrl(id), id);
    assert.equal(parseClientMetadata(id, document(id)).clientId, id);
  }
  for (const id of ['kept_client_abc', 'not a url', 'http://example.com/client.json', 'https://example.com/',
    'https://example.com/client.json#', 'https://example.com/client.json#fragment', 'https://user@example.com/client.json',
    'https://@example.com/client.json', 'https://example.com/a/../client.json', 'https://example.com/%2e/client.json',
    'https://example.com/\\client.json', ' https://example.com/client.json', `https://example.com/${'x'.repeat(2048)}`]) {
    assert.equal(clientMetadataUrl(id), null, id);
  }
});

test('documents require exact client identity, a bounded name, valid registered redirects, and supported authentication', () => {
  for (const changes of [{ client_id: opencode.replace('https:', 'http:') }, { client_name: '' }, { client_name: 'x'.repeat(121) },
    { redirect_uris: [] }, { redirect_uris: ['javascript:alert(1)'] }, { redirect_uris: ['https://evil.example/callback#fragment'] },
    { redirect_uris: Array(11).fill('https://example.com/callback') }, { token_endpoint_auth_method: 'client_secret_basic' },
    { token_endpoint_auth_methods_supported: ['private_key_jwt'] }, { token_endpoint_auth_methods_supported: ['none', 'client_secret_post'] },
    { client_secret: 'must not appear in public metadata' }, { response_types: ['token'] }, { grant_types: ['client_credentials'] },
    { token_endpoint_auth_method: 'private_key_jwt' }]) {
    assert.throws(() => parseClientMetadata(opencode, document(opencode, changes)));
  }
  assert.throws(() => parseClientMetadata(opencode, []));
  assert.equal(parseClientMetadata(opencode, document(opencode, {
    token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt']
  })).clientId, opencode, 'ChatGPT explicitly supports none as an alternative to its preferred method');
  const exact = 'https://example.com:443/client.json';
  assert.equal(parseClientMetadata(exact, document(exact)).clientId, exact);
  assert.throws(() => parseClientMetadata(exact, document('https://example.com/client.json')));
});

test('loopback callbacks may vary only their port; remote redirects still require exact matches', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.ok(redirectUriMatches(`http://${host}:19876/mcp/oauth/callback`, [`http://${host}/mcp/oauth/callback`]));
    assert.ok(redirectUriMatches(`http://${host}:54321/callback?x=1`, [`http://${host}:9876/callback?x=1`]));
  }
  for (const request of ['http://127.0.0.1:19876/other', 'http://127.0.0.1:19876/callback?x=2',
    'http://localhost:19876/callback', 'http://127.0.0.1.attacker.example:19876/callback',
    'http://127.0.0.1:19876/callback#fragment', 'http://user@127.0.0.1:19876/callback',
    'http://127.0.0.1:19876/a/../callback', 'https://127.0.0.1:19876/callback']) {
    assert.equal(redirectUriMatches(request, ['http://127.0.0.1/callback']), false, request);
  }
  assert.equal(redirectUriMatches('https://client.example:9999/callback', ['https://client.example/callback']), false);
  assert.equal(redirectUriMatches('https://client.example/callback', ['https://client.example/callback']), true);
});

test('metadata fetches pin public DNS, preserve TLS, and send only an Accept header', async () => {
  const h = fixture();
  const resolved = await h.resolve(opencode, { get });
  assert.equal(resolved.clientDomain, 'opencode.ai');
  assert.deepEqual(resolved.redirectUris, document().redirect_uris);
  const { url, options } = h.calls[0];
  assert.equal(url.hostname, 'opencode.ai'); assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, undefined);
  assert.deepEqual(options.headers, { Accept: 'application/json' });
  const addresses = await new Promise((resolve, reject) => options.lookup('opencode.ai', { all: true }, (error, result) => error ? reject(error) : resolve(result)));
  assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  assert.deepEqual(h.lookups, ['opencode.ai']);
});

test('private, CGNAT, mixed DNS and redirect destinations cannot be fetched', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1']) {
    const h = fixture({ addresses: [{ address, family: address.includes(':') ? 6 : 4 }] });
    assert.equal(await h.resolve(opencode, { get }), null); assert.equal(h.calls.length, 0);
  }
  const mixed = fixture({ addresses: [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] });
  assert.equal(await mixed.resolve(opencode, { get }), null); assert.equal(mixed.calls.length, 0);
  for (const location of ['https://127.0.0.1/private', 'https://another-public.example/client.json']) {
    const h = fixture({ replies: [{ status: 302, headers: { location } }] });
    assert.equal(await h.resolve(opencode, { get }), null); assert.equal(h.calls.length, 1);
  }
});

test('non-200, non-JSON, malformed and oversized documents are rejected without caching failures', async () => {
  for (const reply of [{ status: 201, metadata: document() }, { metadata: document(), headers: { 'content-type': 'text/html' } },
    { body: '{broken' }, { metadata: document('https://wrong.example/client.json') },
    { metadata: document(), headers: { 'content-length': '5121' } }, { chunks: [Buffer.alloc(3000), Buffer.alloc(3000)] }]) {
    const h = fixture({ replies: [reply, { metadata: document() }] });
    assert.equal(await h.resolve(opencode, { get }), null);
    assert.equal((await h.resolve(opencode, { get })).clientDomain, 'opencode.ai');
    assert.equal(h.calls.length, 2);
  }
});

test('successful metadata caching respects freshness, Age, no-cache/no-store and a one-hour maximum', async () => {
  let now = 0;
  const h = fixture({ now: () => now, replies: [
    { metadata: document(), headers: { 'cache-control': 'max-age=60', age: '30' } },
    { metadata: document(), headers: { 'cache-control': 'max-age=99999999' } }
  ] });
  await h.resolve(opencode, { get }); now = 29000; await h.resolve(opencode, { get }); assert.equal(h.calls.length, 1);
  now = 31000; await h.resolve(opencode, { get }); assert.equal(h.calls.length, 2);
  now += 3600001; await h.resolve(opencode, { get }); assert.equal(h.calls.length, 3);
  for (const control of ['no-store', 'no-cache', 'max-age=0']) {
    const fresh = fixture({ replies: [{ metadata: document(), headers: { 'cache-control': control } }] });
    await fresh.resolve(opencode, { get }); await fresh.resolve(opencode, { get }); assert.equal(fresh.calls.length, 2);
  }
});

test('concurrent requests coalesce and distinct concurrent fetches and cache size are bounded', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const resolve = createClientMetadataResolver({ maxConcurrent: 1, download: async id => { calls++; await gate; return jsonReply(document(id)); } });
  const first = resolve(opencode, { get }), second = resolve(opencode, { get });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await resolve('https://other.example/client.json', { get }), null); assert.equal(calls, 1);
  release(); assert.deepEqual(await first, await second); assert.equal(calls, 1);
  let downloads = 0;
  const limited = createClientMetadataResolver({ maxEntries: 2, download: async id => { downloads++; return jsonReply(document(id)); } });
  const ids = ['a', 'b', 'a', 'c', 'b'].map(host => `https://${host}.example/client.json`);
  for (const id of ids) await limited(id, { get });
  assert.equal(downloads, 4);
});

test('dynamic registrations remain local and a synchronous download failure does not poison retries', async () => {
  let calls = 0;
  const resolve = createClientMetadataResolver({ download: id => { if (++calls === 1) throw new Error('Offline'); return Promise.resolve(jsonReply(document(id))); } });
  assert.equal(await resolve(opencode, { get }), null);
  assert.ok(await resolve(opencode, { get }));
  const registered = await resolve('kept_client_test', { get: async () => ({ clientName: 'Registered client', redirectUris: '["http://localhost:1234/callback"]' }) });
  assert.equal(registered.clientName, 'Registered client'); assert.equal(calls, 2);
});
