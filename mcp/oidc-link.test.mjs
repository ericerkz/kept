import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
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
      const output = String(chunk);
      if (output.trim()) process.stderr.write(output);
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

function bearer(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function startProvider() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: 'test-key', use: 'sig', alg: 'RS256' });
  const codes = new Map();
  let identity = { sub: 'primary-subject', email: 'admin@example.test', name: 'Admin User' };
  let issuer = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer || 'http://127.0.0.1');
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post']
      }));
    }
    if (url.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    if (url.pathname === '/authorize') {
      const code = randomBytes(20).toString('base64url');
      codes.set(code, {
        nonce: url.searchParams.get('nonce'),
        challenge: url.searchParams.get('code_challenge'),
        redirectUri: url.searchParams.get('redirect_uri'),
        identity: { ...identity }
      });
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const record = codes.get(params.get('code'));
      if (!record || record.redirectUri !== params.get('redirect_uri')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      const challenge = createHash('sha256').update(params.get('code_verifier') || '').digest('base64url');
      if (challenge !== record.challenge) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      codes.delete(params.get('code'));
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        iss: issuer, aud: 'kept-test', iat: now, exp: now + 300, nonce: record.nonce,
        sub: record.identity.sub, email: record.identity.email, email_verified: true,
        name: record.identity.name, preferred_username: record.identity.email.split('@')[0]
      })).toString('base64url');
      const input = `${header}.${payload}`;
      const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'provider-access', token_type: 'Bearer', expires_in: 300, id_token: `${input}.${signature}` }));
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  return {
    issuer,
    setIdentity(value) { identity = value; },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}

async function completeProviderRedirect(startUrl) {
  const providerResponse = await fetch(startUrl, { redirect: 'manual' });
  assert.equal(providerResponse.status, 302);
  const callback = providerResponse.headers.get('location');
  assert.ok(callback);
  return callback;
}

test('OIDC accounts can be explicitly linked, signed in, and safely disconnected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kept-oidc-'));
  const provider = await startProvider();
  const port = 33000 + Math.floor(Math.random() * 1000);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), SQLITE_PATH: join(directory, 'kept.sqlite'), BASE_URL: origin,
      KEPT_OIDC_ISSUER: provider.issuer, KEPT_OIDC_CLIENT_ID: 'kept-test',
      KEPT_OIDC_CLIENT_SECRET: 'test-secret', KEPT_OIDC_NAME: 'Test Identity'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  });
  await waitForServer(child);

  await json(`${origin}/api/setup/admin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'oidc-admin', displayName: 'OIDC Admin', password: 'testing123', email: 'admin@example.test' })
  });
  const admin = await json(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'oidc-admin', password: 'testing123' })
  });

  let status = await json(`${origin}/api/auth/oidc/link/status`, { headers: bearer(admin.token) });
  assert.deepEqual({ enabled: status.enabled, connected: status.connected }, { enabled: true, connected: false });

  const linkStart = await json(`${origin}/api/auth/oidc/link/start`, { method: 'POST', headers: bearer(admin.token), body: '{}' });
  const linkCallback = await completeProviderRedirect(linkStart.url);
  const linkResult = await fetch(linkCallback, { redirect: 'manual' });
  assert.equal(linkResult.status, 302);
  assert.equal(new URL(linkResult.headers.get('location'), origin).pathname, '/settings');
  assert.equal(new URL(linkResult.headers.get('location'), origin).searchParams.get('oidc_link'), 'connected');

  status = await json(`${origin}/api/auth/oidc/link/status`, { headers: bearer(admin.token) });
  assert.equal(status.connected, true);
  assert.equal(status.identityEmail, 'admin@example.test');

  const ssoStart = await fetch(`${origin}/api/auth/oidc/start`, { redirect: 'manual' });
  const ssoCallback = await completeProviderRedirect(ssoStart.headers.get('location'));
  const ssoResult = await fetch(ssoCallback, { redirect: 'manual' });
  const loginCode = new URL(ssoResult.headers.get('location'), origin).searchParams.get('oidc_code');
  const ssoLogin = await json(`${origin}/api/auth/oidc/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: loginCode })
  });
  assert.equal(ssoLogin.user.id, admin.user.id);

  const second = await json(`${origin}/api/users`, {
    method: 'POST', headers: bearer(admin.token),
    body: JSON.stringify({ username: 'email-match', displayName: 'Email Match', password: 'testing123', role: 'user', email: 'new@example.test' })
  });
  const secondLogin = await json(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'email-match', password: 'testing123' })
  });

  const collisionStart = await json(`${origin}/api/auth/oidc/link/start`, { method: 'POST', headers: bearer(secondLogin.token), body: '{}' });
  const collisionCallback = await completeProviderRedirect(collisionStart.url);
  const collisionResult = await fetch(collisionCallback, { redirect: 'manual' });
  assert.equal(new URL(collisionResult.headers.get('location'), origin).searchParams.get('oidc_link'), 'already_connected');

  provider.setIdentity({ sub: 'new-subject', email: 'new@example.test', name: 'New User' });
  const unlinkedStart = await fetch(`${origin}/api/auth/oidc/start`, { redirect: 'manual' });
  const unlinkedCallback = await completeProviderRedirect(unlinkedStart.headers.get('location'));
  const unlinkedResult = await fetch(unlinkedCallback, { redirect: 'manual' });
  const unlinkedRedirect = new URL(unlinkedResult.headers.get('location'), origin);
  assert.equal(unlinkedRedirect.searchParams.get('oidc_error'), 'no_account', 'matching email must not link or create an account');

  const secondLinkStart = await json(`${origin}/api/auth/oidc/link/start`, { method: 'POST', headers: bearer(secondLogin.token), body: '{}' });
  const secondLinkCallback = await completeProviderRedirect(secondLinkStart.url);
  const secondLinkResult = await fetch(secondLinkCallback, { redirect: 'manual' });
  assert.equal(new URL(secondLinkResult.headers.get('location'), origin).searchParams.get('oidc_link'), 'connected');

  const secondSsoStart = await fetch(`${origin}/api/auth/oidc/start`, { redirect: 'manual' });
  const secondSsoCallback = await completeProviderRedirect(secondSsoStart.headers.get('location'));
  const secondSsoResult = await fetch(secondSsoCallback, { redirect: 'manual' });
  const secondLoginCode = new URL(secondSsoResult.headers.get('location'), origin).searchParams.get('oidc_code');
  const secondSsoLogin = await json(`${origin}/api/auth/oidc/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: secondLoginCode })
  });
  assert.equal(secondSsoLogin.user.id, second.id);

  const disconnected = await fetch(`${origin}/api/auth/oidc/link`, { method: 'DELETE', headers: bearer(secondLogin.token) });
  assert.equal(disconnected.status, 204);
  const localLogin = await json(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'email-match', password: 'testing123' })
  });
  assert.equal(localLogin.user.id, second.id);
});
