import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Kept server exited early with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/setup/status`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the Kept test server.');
}

async function api(baseUrl, pathname, { token, method = 'GET', body, form, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}/api${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(form ? { body: new URLSearchParams(form) } : {}),
    redirect: 'manual'
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = response.status === 204 ? null : contentType.includes('application/json') ? await response.json() : await response.text();
  assert.equal(response.status, expected, `${method} ${pathname}: ${JSON.stringify(payload)}`);
  return payload;
}

test('dedicated MCP access is opt-in, scoped, revocable, and capability gated', { timeout: 25_000 }, async () => {
  const port = 4300 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = path.join(os.tmpdir(), `kept-mcp-${process.pid}-${Date.now()}.sqlite`);
  const child = childProcess.spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    await waitForServer(baseUrl, child);
    await api(baseUrl, '/setup/admin', {
      method: 'POST', expected: 201,
      body: { username: 'mcp-test', displayName: 'MCP Test', password: 'test-password-123' }
    });
    const login = await api(baseUrl, '/auth/login', { method: 'POST', body: { username: 'mcp-test', password: 'test-password-123' } });
    const sessionToken = login.token;

    const defaults = await api(baseUrl, '/users/me/mcp-access', { token: sessionToken });
    assert.deepEqual({ enabled: defaults.enabled, locked: defaults.allowLockedNotes, deletion: defaults.allowPermanentDelete }, { enabled: false, locked: false, deletion: false });

    const enabled = await api(baseUrl, '/users/me/mcp-access/enable', { token: sessionToken, method: 'POST', body: {}, expected: 201 });
    assert.match(enabled.accessToken, /^kept_mcp_[a-f0-9]{64}$/);
    const mcpToken = enabled.accessToken;
    const status = await api(baseUrl, '/mcp/status', { token: mcpToken });
    assert.equal(status.userId, login.user.id);
    assert.equal(status.allowPermanentDelete, false);
    await api(baseUrl, '/users/me/preferences', { token: mcpToken, expected: 403 });

    const ordinary = await api(baseUrl, '/notes', {
      token: sessionToken, method: 'POST', expected: 201,
      body: { noteTitle: 'Ordinary', noteBody: 'Agent-readable body', checkBoxes: [], images: [], labels: [] }
    });
    assert.equal((await api(baseUrl, `/notes/${ordinary.id}`, { token: mcpToken })).noteBody, 'Agent-readable body');
    await api(baseUrl, `/notes/${ordinary.id}`, { token: mcpToken, method: 'DELETE', expected: 403 });

    const passcode = 'correct horse';
    const salt = 'mcp-integration-salt';
    const lockHash = `pbkdf2:${crypto.pbkdf2Sync(passcode, salt, 150000, 32, 'sha256').toString('base64url')}`;
    const locked = await api(baseUrl, '/notes', {
      token: sessionToken, method: 'POST', expected: 201,
      body: { noteTitle: 'Locked', noteBody: 'Private body', locked: true, lockSalt: salt, lockHash, checkBoxes: [], images: [], labels: [] }
    });
    const redacted = await api(baseUrl, `/notes/${locked.id}`, { token: mcpToken });
    assert.equal(redacted.noteBody, '');
    assert.equal(redacted.lockedContentAvailable, false);
    assert.equal('lockHash' in redacted, false);
    assert.equal((await api(baseUrl, '/notes/search?q=Private', { token: mcpToken })).some(note => note.id === locked.id), false);
    assert.equal((await api(baseUrl, '/notes/search?q=Locked', { token: mcpToken })).some(note => note.id === locked.id), true);
    await api(baseUrl, `/mcp/locked-notes/${locked.id}/unlock`, { token: mcpToken, method: 'POST', body: {}, expected: 403 });

    await api(baseUrl, '/users/me/external-access/capabilities', {
      token: sessionToken, method: 'PATCH',
      body: { allowLockedNotes: true, allowPermanentDelete: true }
    });
    const challenge = await api(baseUrl, `/mcp/locked-notes/${locked.id}/unlock`, { token: mcpToken, method: 'POST', body: {}, expected: 201 });
    const challengePath = new URL(challenge.unlockUrl).pathname.replace(/^\/api/, '');
    await api(baseUrl, challengePath, { method: 'POST', form: { passcode }, expected: 200 });
    const revealed = await api(baseUrl, `/notes/${locked.id}`, { token: mcpToken });
    assert.equal(revealed.noteBody, 'Private body');
    assert.equal(revealed.lockedContentAvailable, true);

    await api(baseUrl, '/users/me/external-access/capabilities', { token: sessionToken, method: 'PATCH', body: { allowLockedNotes: false } });
    assert.equal((await api(baseUrl, `/notes/${locked.id}`, { token: mcpToken })).lockedContentAvailable, false);

    await api(baseUrl, `/notes/${ordinary.id}`, { token: mcpToken, method: 'DELETE', expected: 204 });
    await api(baseUrl, '/users/me/mcp-access', { token: sessionToken, method: 'DELETE', expected: 204 });
    await api(baseUrl, '/mcp/status', { token: mcpToken, expected: 401 });
  } finally {
    const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    child.kill('SIGTERM');
    await exited;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }

  assert.equal(stderr, '', stderr);
});
