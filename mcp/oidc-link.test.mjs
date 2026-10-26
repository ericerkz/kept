import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider, completeProviderRedirect } from '../test-support/oidc-provider.mjs';

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

test('OIDC accounts can be explicitly linked, signed in, and safely disconnected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kept-oidc-'));
  const provider = await startProvider();
  const port = 33000 + Math.floor(Math.random() * 1000);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: directory, SQLITE_PATH: join(directory, 'kept.sqlite'), BASE_URL: origin,
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

  const nativeSsoStart = await fetch(`${origin}/api/auth/oidc/start?return_url=${encodeURIComponent('kept://auth/oidc')}`, { redirect: 'manual' });
  const nativeSsoCallback = await completeProviderRedirect(nativeSsoStart.headers.get('location'));
  const nativeSsoResult = await fetch(nativeSsoCallback, { redirect: 'manual' });
  const nativeRedirect = new URL(nativeSsoResult.headers.get('location'));
  assert.equal(`${nativeRedirect.protocol}//${nativeRedirect.hostname}${nativeRedirect.pathname}`, 'kept://auth/oidc');
  assert.match(nativeRedirect.searchParams.get('oidc_code'), /^kept_login_/);

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

  provider.setIdentity({ sub: 'native-link-subject', email: 'native@example.test', name: 'Native Link' });
  const nativeLinkStart = await json(`${origin}/api/auth/oidc/link/start`, {
    method: 'POST', headers: bearer(secondLogin.token),
    body: JSON.stringify({ return_url: 'kept://auth/oidc' })
  });
  const nativeLinkCallback = await completeProviderRedirect(nativeLinkStart.url);
  const nativeLinkResult = await fetch(nativeLinkCallback, { redirect: 'manual' });
  const nativeLinkRedirect = new URL(nativeLinkResult.headers.get('location'));
  assert.equal(`${nativeLinkRedirect.protocol}//${nativeLinkRedirect.hostname}${nativeLinkRedirect.pathname}`, 'kept://auth/oidc');
  assert.equal(nativeLinkRedirect.searchParams.get('oidc_link'), 'connected');

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
