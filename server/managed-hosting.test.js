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
    const login = await request(base, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'selfhost-admin', password: 'test-password-123' })
    });
    const notes = await request(base, '/notes', { headers: { Authorization: `Bearer ${login.body.token}` } });
    assert.strictEqual(notes.status, 200);
    assert.strictEqual(notes.body.length, 0, 'ordinary self-host setup must not create a managed welcome note');

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
    BASE_URL: 'https://mossy-quarry-wombat.cloud.example.test:8443/kept/',
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
      notes.body.filter(note => /Welcome to Acme Hosting/.test(note.noteTitle)).length === 1,
      'a managed welcome note should exist exactly once after setup'
    );
    const welcome = notes.body.find(note => note.noteTitle === 'Welcome to Acme Hosting!');
    assert.ok(welcome, 'welcome title ends with an exclamation mark');
    assert.strictEqual(welcome.pinned, true);
    assert.strictEqual(welcome.linkPreviews, false, 'compact app/account links should not become large preview cards');
    assert.match(welcome.noteBody, /<h3>/);
    assert.match(welcome.noteBody, /apps\.apple\.com\/ca\/app\/kept-notes\/id6768974473/);
    assert.match(welcome.noteBody, /play\.google\.com\/store\/apps\/details\?id=xyz\.keepitkept\.app/);
    assert.match(welcome.noteBody, /100 MiB/);
    assert.match(welcome.noteBody, /5 GB of storage/);
    const sharingHeading = '<h3>👪 Share it with friends and family</h3>';
    assert.ok(welcome.noteBody.includes(sharingHeading));
    assert.ok(welcome.noteBody.indexOf(sharingHeading) > welcome.noteBody.indexOf('📱 Take Kept with you'));
    assert.ok(welcome.noteBody.indexOf(sharingHeading) < welcome.noteBody.indexOf('☁️ Your space, taken care of'));
    assert.ok(welcome.noteBody.includes('<strong>Users</strong> in the menu (Add a user)'));
    assert.ok(welcome.noteBody.includes('choose a username and password for each of them.'));
    assert.ok(welcome.noteBody.includes('tap <strong>Acme Hosting</strong>'));
    assert.ok(welcome.noteBody.includes("<strong>Joining someone else's Acme Hosting?</strong>"));
    assert.ok(welcome.noteBody.includes("your server's name: <strong>mossy-quarry-wombat</strong>"));
    assert.ok(welcome.noteBody.includes('Then they sign in with the username and password you chose.'));
    // Browser and offline-first starter creation must both keep the welcome
    // note first, even when the starter was created with a newer sortOrder.
    const demo = await request(base, '/notes', { method:'POST', headers:authHeaders,
      body:JSON.stringify({noteTitle:'Saved Links',pinned:true,isDemo:true,labels:[],images:[]}) });
    assert.strictEqual(demo.status,201);
    const synced = await request(base, '/sync/mutations', { method:'POST',headers:authHeaders,
      body:JSON.stringify({protocolVersion:2,mutations:[{type:'note.upsert',syncId:'starter-sync',operationId:'starter-sync',
        payload:{noteTitle:'Synced starter',pinned:true,isDemo:true,sortOrder:Date.now()+10000},
        lww:{physicalMs:Date.now(),logical:0,deviceId:'starter-test',operationId:'starter-sync'}}]}) });
    assert.strictEqual(synced.body.results[0].ok,true);
    const cards = await request(base, '/notes?view=card', {headers:authHeaders});
    assert.strictEqual(cards.body.notes[0].id,welcome.id,'the welcome is the first/top-left note after seeding');
    assert.strictEqual(cards.body.notes[0].linkPreviews,false,'overview cards preserve compact links');
    const bootstrap = await request(base, '/sync/bootstrap?protocolVersion=2', {headers:authHeaders});
    assert.strictEqual(bootstrap.body.notes[0].id,welcome.id,'native offline snapshots preserve first position');
    // The welcome note remains a normal note the user can unpin.
    await request(base, `/notes/${welcome.id}`, {method:'PATCH',headers:authHeaders,
      body:JSON.stringify({pinned:false,noteBody:'Personalized welcome note'})});
    assert.strictEqual((await request(base, `/notes/${welcome.id}`, {headers:authHeaders})).body.pinned,false);

    const reusedToken = await request(base, '/setup/admin', {
      method: 'POST',
      headers: { 'X-Kept-Setup-Token': 'secret-token-abc' },
      body: JSON.stringify({ username: 'second-admin', displayName: 'Admin 2', password: 'test-password-123' })
    });
    assert.strictEqual(reusedToken.status, 409, 'the setup token must be useless once the original admin exists');
    const retainedNotes = await request(base, '/notes', { headers: authHeaders });
    const retainedWelcome = retainedNotes.body.filter(note => note.id === welcome.id);
    assert.strictEqual(retainedWelcome.length, 1, 'setup retries must not replace or duplicate the welcome note');
    assert.strictEqual(retainedWelcome[0].noteBody, 'Personalized welcome note');

    const storage = await request(base, '/settings/storage', { headers: authHeaders });
    assert.strictEqual(storage.status, 200);
    assert.strictEqual(typeof storage.body.usedBytes, 'number');
    assert.strictEqual(storage.body.quotaBytes, 5 * 1024 * 1024 * 1024);
    assert.strictEqual(typeof storage.body.percentUsed, 'number');
  });

  // Invalid public addresses fall back to the full address, safely escaped.
  await withServer({
    KEPT_MANAGED_HOSTING: '1',
    KEPT_MANAGED_PROVIDER_NAME: 'Acme & Family <Hosting>',
    BASE_URL: 'mossy-quarry-wombat/<household>?a=1&b=2'
  }, async base => {
    const credentials = { username: 'fallback-admin', password: 'test-password-123' };
    assert.strictEqual((await request(base, '/setup/admin', {
      method: 'POST', body: JSON.stringify(credentials)
    })).status, 201);
    const login = await request(base, '/auth/login', { method: 'POST', body: JSON.stringify(credentials) });
    const notes = await request(base, '/notes', { headers: { Authorization: `Bearer ${login.body.token}` } });
    assert.strictEqual(notes.status, 200);
    assert.strictEqual(notes.body.length, 1);
    const body = notes.body[0].noteBody;
    assert.ok(body.includes("<strong>Joining someone else's Acme &amp; Family &lt;Hosting&gt;?</strong>"));
    assert.ok(body.includes('<strong>mossy-quarry-wombat/&lt;household&gt;?a=1&amp;b=2</strong>'));
    assert.ok(!body.includes('<household>') && !body.includes('<Hosting>'));
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
    assert.strictEqual(body.code, 'STORAGE_QUOTA_EXCEEDED');
    assert.match(body.error, /storage is full/);
  });

  // ── Metrics token: read-only access to storage usage without a login ───
  await withServer({ KEPT_METRICS_TOKEN: 'metrics-secret-abc' }, async base => {
    const noToken = await request(base, '/settings/storage');
    assert.strictEqual(noToken.status, 401, 'storage usage still requires auth or a metrics token by default');

    const wrongToken = await request(base, '/settings/storage', { headers: { 'X-Kept-Metrics-Token': 'wrong' } });
    assert.strictEqual(wrongToken.status, 401);

    const withToken = await request(base, '/settings/storage', { headers: { 'X-Kept-Metrics-Token': 'metrics-secret-abc' } });
    assert.strictEqual(withToken.status, 200);
    assert.strictEqual(typeof withToken.body.usedBytes, 'number');
  });

  console.log('Managed hosting tests passed.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
