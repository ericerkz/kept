const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const port = 4300 + Math.floor(Math.random() * 1000);
const dbPath = path.join(os.tmpdir(), `kept2-relay-${process.pid}.sqlite`);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kept2-relay-data-'));
const base = `http://127.0.0.1:${port}/api`;

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${text}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function waitForServer(child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}`);
    try {
      await request('/setup/status');
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  throw new Error('Server did not start in time.');
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function mutation(envelope, overrides = {}) {
  return {
    operationId: envelope.lww.operationId,
    mutationType: 'resource.upsert',
    resourceId: envelope.resourceId,
    payload: { envelope },
    lww: envelope.lww,
    createdAt: new Date().toISOString(),
    attempts: 0,
    ...overrides
  };
}

async function main() {
  const child = childProcess.spawn('node', ['server/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath, DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));

  try {
    await waitForServer(child);
    await request('/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username: 'kept2', displayName: 'Kept 2', password: 'test-password-123' })
    });
    const login = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'kept2', password: 'test-password-123' })
    });
    const headers = bearer(login.token);
    const capabilities = await request('/v2/capabilities', { headers });
    assert.equal(capabilities.protocolVersion, 'encrypted-v1');
    assert.equal(capabilities.contentBlindRealtime, true);

    const vaultId = 'vault-test';
    const envelope = {
      resourceId: 'note-test',
      resourceType: 'note.content',
      keyEpoch: 1,
      lww: { physicalMs: Date.now(), logical: 0, deviceId: 'device-test', operationId: 'op-1' },
      ciphertext: 'opaque-ciphertext',
      nonce: 'opaque-nonce',
      aad: { resourceId: 'note-test' },
      ciphertextHash: 'opaque-hash',
      schemaVersion: 1
    };
    const first = await request(`/v2/vaults/${vaultId}/mutations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [mutation(envelope)]
      })
    });
    assert.equal(first[0].ok, true);
    assert.ok(first[0].sequence > 0);

    const snapshot = await request(`/v2/vaults/${vaultId}/bootstrap`, { headers });
    assert.equal(snapshot.envelopes.length, 1);
    assert.equal(snapshot.envelopes[0].ciphertext, 'opaque-ciphertext');
    assert.equal(snapshot.envelopes[0].resourceId, 'note-test');

    const changes = await request(`/v2/vaults/${vaultId}/changes?cursor=0`, { headers });
    assert.equal(changes.changes.length, 1);
    assert.equal(changes.changes[0].operation, 'upsert');
    assert.equal(changes.changes[0].envelope.ciphertext, 'opaque-ciphertext');

    const replay = await request(`/v2/vaults/${vaultId}/mutations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [mutation(envelope, { attempts: 1 })]
      })
    });
    assert.equal(replay[0].ok, true);
    assert.equal(replay[0].skipped, true, 'same operation id can be retried with changed retry metadata');

    const conflicting = await request(`/v2/vaults/${vaultId}/mutations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [mutation({ ...envelope, ciphertext: 'different-ciphertext' }, { attempts: 2 })]
      })
    });
    assert.equal(conflicting[0].ok, false, 'operation id must not be reused with different encrypted payload');

    const newer = {
      ...envelope,
      resourceId: 'note-lww',
      lww: { physicalMs: 3000, logical: 0, deviceId: 'device-b', operationId: 'op-lww-newer' },
      ciphertext: 'newer-ciphertext',
      aad: { resourceId: 'note-lww' },
      ciphertextHash: 'newer-hash'
    };
    const older = {
      ...newer,
      lww: { physicalMs: 2000, logical: 0, deviceId: 'device-a', operationId: 'op-lww-older' },
      ciphertext: 'older-ciphertext',
      ciphertextHash: 'older-hash'
    };
    const newerResult = await request(`/v2/vaults/${vaultId}/mutations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mutations: [mutation(newer)] })
    });
    assert.equal(newerResult[0].ok, true);
    const staleResult = await request(`/v2/vaults/${vaultId}/mutations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mutations: [mutation(older)] })
    });
    assert.equal(staleResult[0].ok, true);
    assert.equal(staleResult[0].skipped, true);
    assert.equal(staleResult[0].stale, true);

    const lwwSnapshot = await request(`/v2/vaults/${vaultId}/bootstrap`, { headers });
    const lwwEnvelope = lwwSnapshot.envelopes.find(item => item.resourceId === 'note-lww');
    assert.equal(lwwEnvelope.ciphertext, 'newer-ciphertext', 'stale upsert must not replace newer envelope');

    const deleteLww = { physicalMs: 4000, logical: 0, deviceId: 'device-c', operationId: 'op-lww-delete' };
    const deleted = await request(`/v2/vaults/${vaultId}/mutations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          operationId: deleteLww.operationId,
          mutationType: 'resource.delete',
          resourceId: 'note-lww',
          payload: { resourceType: 'note.content' },
          lww: deleteLww,
          createdAt: new Date().toISOString(),
          attempts: 0
        }]
      })
    });
    assert.equal(deleted[0].ok, true);
    const resurrect = await request(`/v2/vaults/${vaultId}/mutations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [mutation({
          ...newer,
          lww: { physicalMs: 3500, logical: 0, deviceId: 'device-d', operationId: 'op-lww-resurrect' },
          ciphertext: 'resurrected-ciphertext',
          ciphertextHash: 'resurrected-hash'
        })]
      })
    });
    assert.equal(resurrect[0].ok, true);
    assert.equal(resurrect[0].stale, true, 'stale upsert must not resurrect a newer tombstone');
    const postDeleteSnapshot = await request(`/v2/vaults/${vaultId}/bootstrap`, { headers });
    assert.equal(postDeleteSnapshot.envelopes.some(item => item.resourceId === 'note-lww'), false);

    console.log('Kept 2 relay tests passed.');
  } finally {
    child.kill('SIGTERM');
    try { fs.rmSync(dbPath, { force: true }); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
