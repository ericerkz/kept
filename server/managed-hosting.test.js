const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');

function freshPort() {
  return 3700 + Math.floor(Math.random() * 1000);
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

async function waitForServer(base, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}`);
    try {
      const { status } = await request(base, '/setup/status');
      if (status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Server did not start in time.');
}

function spawnServer(env) {
  const port = freshPort();
  const dbPath = path.join(os.tmpdir(), `kept-managed-${process.pid}-${port}.sqlite`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-managed-data-'));
  const child = childProcess.spawn('node', ['server/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath, DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderrChunks = [];
  child.stderr.on('data', chunk => stderrChunks.push(chunk));
  return { child, base: `http://127.0.0.1:${port}/api`, dataDir, getStderr: () => Buffer.concat(stderrChunks).toString('utf8') };
}

async function withServer(env, fn) {
  const { child, base, dataDir, getStderr } = spawnServer(env);
  try {
    await waitForServer(base, child);
    await fn(base);
  } catch (error) {
    process.stderr.write(getStderr());
    throw error;
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  // ── Ordinary self-hosting: no managed env vars set ──────────────────────
  await withServer({}, async base => {
    const managed = await request(base, '/settings/managed-hosting');
    assert.strictEqual(managed.status, 200);
    assert.strictEqual(managed.body.managed, false);
    assert.strictEqual(managed.body.quotaBytes, null);

    const setup = await request(base, '/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username: 'selfhost-admin', displayName: 'Admin', password: 'test-password-123' })
    });
    assert.strictEqual(setup.status, 201, 'self-host setup should succeed without any setup token');

    const health = await request(base, '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.checks.database, true);
    assert.strictEqual(health.body.checks.dataDirectoryWritable, true);
  });

  // ── Managed hosting: setup token required, then useless after setup ────
  await withServer({
    KEPT_SETUP_TOKEN: 'secret-token-abc',
    KEPT_MANAGED_HOSTING: '1',
    KEPT_MANAGED_PROVIDER_NAME: 'Acme Hosting',
    KEPT_MANAGED_ACCOUNT_URL: 'https://cloud.example.test/account',
    KEPT_STORAGE_QUOTA_BYTES: String(5 * 1024 * 1024 * 1024)
  }, async base => {
    const managed = await request(base, '/settings/managed-hosting');
    assert.strictEqual(managed.body.managed, true);
    assert.strictEqual(managed.body.providerName, 'Acme Hosting');
    assert.strictEqual(managed.body.quotaBytes, 5 * 1024 * 1024 * 1024);

    const noToken = await request(base, '/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username: 'cloud-admin', displayName: 'Admin', password: 'test-password-123' })
    });
    assert.strictEqual(noToken.status, 403, 'setup without the setup token should be rejected');

    const wrongToken = await request(base, '/setup/admin', {
      method: 'POST',
      headers: { 'X-Kept-Setup-Token': 'wrong' },
      body: JSON.stringify({ username: 'cloud-admin', displayName: 'Admin', password: 'test-password-123' })
    });
    assert.strictEqual(wrongToken.status, 403, 'setup with the wrong setup token should be rejected');

    const withToken = await request(base, '/setup/admin', {
      method: 'POST',
      headers: { 'X-Kept-Setup-Token': 'secret-token-abc' },
      body: JSON.stringify({ username: 'cloud-admin', displayName: 'Admin', password: 'test-password-123' })
    });
    assert.strictEqual(withToken.status, 201, 'setup with the correct setup token should succeed');

    const login = await request(base, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'cloud-admin', password: 'test-password-123' })
    });
    assert.strictEqual(login.status, 200);
    const authHeaders = { Authorization: `Bearer ${login.body.token}` };

    const notes = await request(base, '/notes', { headers: authHeaders });
    assert.strictEqual(notes.status, 200);
    assert.ok(
      notes.body.some(note => /Welcome to Acme Hosting/.test(note.noteTitle)),
      'a managed welcome note should exist exactly once after setup'
    );

    const reusedToken = await request(base, '/setup/admin', {
      method: 'POST',
      headers: { 'X-Kept-Setup-Token': 'secret-token-abc' },
      body: JSON.stringify({ username: 'second-admin', displayName: 'Admin 2', password: 'test-password-123' })
    });
    assert.strictEqual(reusedToken.status, 409, 'the setup token must be useless once the original admin exists');

    const storage = await request(base, '/settings/storage', { headers: authHeaders });
    assert.strictEqual(storage.status, 200);
    assert.strictEqual(typeof storage.body.usedBytes, 'number');
    assert.strictEqual(storage.body.quotaBytes, 5 * 1024 * 1024 * 1024);
    assert.strictEqual(typeof storage.body.percentUsed, 'number');
  });

  // ── Storage quota: exceeding it rejects uploads with 507 ────────────────
  await withServer({ KEPT_STORAGE_QUOTA_BYTES: '1024' }, async base => {
    await request(base, '/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username: 'quota-admin', displayName: 'Admin', password: 'test-password-123' })
    });
    const login = await request(base, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'quota-admin', password: 'test-password-123' })
    });
    const authHeaders = { Authorization: `Bearer ${login.body.token}` };

    const form = new FormData();
    const bytes = new Uint8Array(2000);
    form.append('image', new Blob([bytes], { type: 'image/png' }), 'test.png');
    const response = await fetch(`${base}/uploads/images`, {
      method: 'POST',
      headers: authHeaders,
      body: form
    });
    assert.strictEqual(response.status, 507, 'an upload that would exceed quota should fail with 507');
    const body = await response.json();
    assert.strictEqual(body.error.includes('quota'), true);
  });

  console.log('Managed hosting tests passed.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
