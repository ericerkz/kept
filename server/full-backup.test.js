const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');
const AdmZip = require('adm-zip');
const { startFixture } = require('../test-support/session-fixture.cjs');
const { stageReplacements, installReplacements, rollbackReplacements, cleanupReplacements } = require('./full-backup');

const owner = { username: 'backup-owner', displayName: 'Owner', password: 'backup-password-123' };
const member = { username: 'backup-member', displayName: 'Member', password: 'member-password-123' };
async function api(fixture, route, { token, body, method = body ? 'POST' : 'GET', status = 200, headers = {} } = {}) {
  const form = body instanceof FormData;
  const response = await fetch(fixture.origin + '/api' + route, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body && !form ? { 'Content-Type': 'application/json' } : {}), ...headers
  }, body: body ? form ? body : JSON.stringify(body) : undefined });
  assert.equal(response.status, status, `${route}: ${await response.clone().text()}`);
  return response;
}
async function setup(fixture) {
  await api(fixture, '/setup/admin', { body: owner, status: 201 });
  return (await (await api(fixture, '/auth/login', { body: owner })).json()).token;
}
function upload(bytes, name = 'server.zip') {
  const form = new FormData();
  form.append('backup', new Blob([bytes]), name);
  return form;
}
function archive(files, changes = {}) {
  const zip = new AdmZip();
  const entries = Object.entries(files).map(([name, bytes]) => ({ path: name, size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
  for (const [name, bytes] of Object.entries(files)) zip.addFile(name, bytes);
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'kept-server-backup', version: 1, entries, ...changes })));
  return zip;
}

test('full server backup works with external backups and restores all accounts and media', async t => {
  const source = await startFixture({ env: { KEPT_MANAGED_HOSTING: '1', KEPT_EXTERNAL_BACKUPS: '1' } });
  const target = await startFixture({ env: { KEPT_ALLOW_RESTORE: '1' } });
  const legacy = await startFixture({ env: { KEPT_ALLOW_RESTORE: '1' } });
  t.after(async () => { await Promise.all([source.close(), target.close(), legacy.close()]); });
  const token = await setup(source);
  await source.sql('PRAGMA journal_mode = WAL');
  await api(source, '/users', { token, body: { ...member, role: 'user' }, status: 201 });
  const otherToken = (await (await api(source, '/auth/login', { body: member })).json()).token;
  await api(source, '/notes', { token: otherToken, body: { noteTitle: 'Another user’s note' }, status: 201 });
  await api(source, '/admin/backup/full', { method: 'POST', status: 401 });
  await api(source, '/admin/backup/full', { token: otherToken, method: 'POST', status: 403 });
  await api(source, '/admin/backup/schedule', { token, body: { schedule: 'daily' }, status: 409 });
  assert.equal((await (await api(source, '/settings/managed-hosting')).json()).externalBackups, true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const imageForm = new FormData(); imageForm.append('image', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const image = await (await api(source, '/uploads/images', { token, body: imageForm, status: 201 })).json();
  const note = await (await api(source, '/notes', { token, body: { noteTitle: 'Full backup', isCbox: true,
    checkBoxes: [{ id: 'row-1', text: 'Checklist', checked: true }],
    images: [{ id: 'image-1', dataUrl: image.url, placement: 'top' }] }, status: 201 })).json();
  const attachmentText = 'A complete backup includes this attachment.';
  const fileForm = new FormData(); fileForm.append('file', new Blob([attachmentText], { type: 'text/plain' }), 'test.txt');
  const attachment = await (await api(source, `/notes/${note.id}/attachments`, { token, body: fileForm, status: 201 })).json();
  const anonymousResponse = await api(source, '/auth/browser/session');
  const cookie = anonymousResponse.headers.get('set-cookie').split(';')[0];
  const csrf = (await anonymousResponse.json()).csrfToken;
  const browserLogin = await api(source, '/auth/browser/login', { body: owner, headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
  const browserCookie = browserLogin.headers.get('set-cookie').split(';')[0];
  const browserCsrf = (await browserLogin.json()).csrfToken;
  await api(source, '/admin/backup/full', { method: 'POST', headers: { Cookie: browserCookie }, status: 403 });
  const backup = await (await api(source, '/admin/backup/full', { method: 'POST',
    headers: { Cookie: browserCookie, 'X-CSRF-Token': browserCsrf } })).json();
  assert.match(backup.filename, /^backup-.+-full\.zip$/);
  const response = await api(source, `/admin/backup/download/${backup.filename}`, { headers: { Cookie: browserCookie } });
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, backup.size);
  const zip = new AdmZip(bytes);
  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  for (const entry of manifest.entries) {
    const contents = zip.readFile(entry.path);
    assert.equal(contents.length, entry.size);
    assert.equal(crypto.createHash('sha256').update(contents).digest('hex'), entry.sha256);
  }
  const partial = await api(source, `/admin/backup/download/${backup.filename}`, { token,
    headers: { Range: 'bytes=0-127', Origin: 'http://localhost:' + new URL(source.origin).port }, status: 206 });
  assert.equal(partial.headers.get('content-range'), `bytes 0-127/${backup.size}`);
  assert.match(partial.headers.get('access-control-expose-headers'), /Content-Range/);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 128));
  await api(source, `/admin/backup/download/${backup.filename}`, { token: otherToken, status: 403 });
  await api(source, `/admin/backup/download/${backup.filename}?token=${token}`, { status: 401 });
  const status = await (await api(source, '/admin/backup/status', { token })).json();
  assert.ok(status.files.some(file => file.filename === backup.filename));
  assert.ok(status.lastManualAt);
  await api(target, '/setup/restore', { body: upload(bytes) });
  const restoredToken = (await (await api(target, '/auth/login', { body: owner })).json()).token;
  assert.equal((await (await api(source, '/push/vapid-public-key', { token })).json()).publicKey,
    (await (await api(target, '/push/vapid-public-key', { token: restoredToken })).json()).publicKey, 'web-push identity survives restore');
  const loaded = await (await api(target, `/notes/${note.id}`, { token: restoredToken })).json();
  assert.equal(loaded.syncId, note.syncId);
  assert.equal(loaded.checkBoxes[0].id, 'row-1');
  assert.deepEqual(Buffer.from(await (await api(target, image.url.replace('/api', ''), { token: restoredToken })).arrayBuffer()), png);
  assert.equal(await (await api(target, `/attachments/${attachment.id}`, { token: restoredToken })).text(), attachmentText);
  const restoredMember = (await (await api(target, '/auth/login', { body: member })).json()).token;
  assert.ok((await (await api(target, '/notes', { token: restoredMember })).json()).some(item => item.noteTitle === 'Another user’s note'));
  await api(target, '/setup/restore', { body: upload(bytes), status: 403 });
  await target.restart();
  await api(target, `/notes/${note.id}`, { token: restoredToken });
  const old = await (await api(source, '/admin/backup/now', { token, method: 'POST' })).json();
  const sqlite = Buffer.from(await (await api(source, `/admin/backup/download/${old.filename}`, { token })).arrayBuffer());
  await api(legacy, '/setup/restore', { body: upload(sqlite, 'old.sqlite') });
  const legacyToken = (await (await api(legacy, '/auth/login', { body: owner })).json()).token;
  await api(legacy, `/notes/${note.id}`, { token: legacyToken });
  await api(source, `/admin/backup/${backup.filename}`, { token, method: 'DELETE', status: 204 });
  await api(source, `/admin/backup/download/${backup.filename}`, { token, status: 404 });
});

test('restore rejects unsafe, damaged and wrong-format archives before replacing live data', async t => {
  const source = await startFixture();
  const target = await startFixture({ env: { KEPT_ALLOW_RESTORE: '1' } });
  t.after(async () => { await source.close(); await target.close(); });
  const token = await setup(source);
  const old = await (await api(source, '/admin/backup/now', { token, method: 'POST' })).json();
  const database = Buffer.from(await (await api(source, `/admin/backup/download/${old.filename}`, { token })).arrayBuffer());
  const sentinel = path.join(target.directory, 'uploads', 'existing.png');
  await fs.writeFile(sentinel, 'existing data');
  const cases = [Buffer.from('not a backup')];
  const corrupt = archive({ 'kept.sqlite': database });
  corrupt.updateFile('kept.sqlite', Buffer.from('corrupted database'));
  cases.push(corrupt.toBuffer());
  cases.push(archive({ 'kept.sqlite': database }, { format: 'kept' }).toBuffer());
  cases.push(archive({ 'uploads/image.png': Buffer.from('missing database') }).toBuffer());
  const traversal = archive({ 'kept.sqlite': database });
  // adm-zip sanitizes paths when creating archives; mutate an existing name
  // without changing lengths to exercise an actual untrusted ZIP path.
  traversal.addFile('uploads/xx/outside', Buffer.from('escape'));
  cases.push(Buffer.from(traversal.toBuffer().toString('latin1').replaceAll('uploads/xx/outside', 'uploads/../outside'), 'latin1'));
  const link = archive({ 'kept.sqlite': database });
  link.addFile('uploads/link', Buffer.from('/etc/passwd'));
  link.getEntry('uploads/link').header.attr = (0xa1ff << 16) >>> 0;
  cases.push(link.toBuffer());
  for (const bytes of cases) {
    await api(target, '/setup/restore', { body: upload(bytes), status: 400 });
    assert.equal((await (await api(target, '/setup/status')).json()).hasUsers, false);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'existing data');
    await api(target, '/health');
    assert.deepEqual(await fs.readdir(path.join(target.directory, 'backups')), []);
  }
});

test('restore is opt-in, upload-bounded and enforces the destination storage quota', async t => {
  for (const [env, status] of [[{}, 403], [{ KEPT_ALLOW_RESTORE: '1', KEPT_BACKUP_UPLOAD_MAX: '1KB' }, 413],
    [{ KEPT_ALLOW_RESTORE: '1', KEPT_STORAGE_QUOTA_BYTES: '1' }, 507]]) {
    await t.test(String(status), async t => {
      const fixture = await startFixture({ env }); t.after(() => fixture.close());
      const bytes = status === 507 ? archive({ 'kept.sqlite': Buffer.alloc(16384) }).toBuffer() : Buffer.alloc(16384);
      await api(fixture, '/setup/restore', { body: upload(bytes), status });
      assert.equal((await (await api(fixture, '/setup/status')).json()).hasUsers, false);
      assert.deepEqual(await fs.readdir(path.join(fixture.directory, 'backups')).catch(() => []), []);
    });
  }
});

test('failed database initialization rolls back the database and media', async t => {
  const fixture = await startFixture({ env: { KEPT_ALLOW_RESTORE: '1' } }); t.after(() => fixture.close());
  const bad = path.join(fixture.directory, 'bad.sqlite');
  const connection = new sqlite3.Database(bad);
  await new Promise((resolve, reject) => connection.exec('CREATE TABLE users (id INTEGER); CREATE TABLE notes (id INTEGER);', error => error ? reject(error) : resolve()));
  await new Promise(resolve => connection.close(resolve));
  const sentinel = path.join(fixture.directory, 'uploads', 'existing.png');
  await fs.writeFile(sentinel, 'existing data');
  const bytes = archive({ 'kept.sqlite': await fs.readFile(bad), 'uploads/new.png': Buffer.from('new data') }).toBuffer();
  await api(fixture, '/setup/restore', { body: upload(bytes), status: 500 });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'existing data');
  assert.deepEqual(await fs.readdir(path.join(fixture.directory, 'uploads')), ['existing.png']);
  assert.equal((await (await api(fixture, '/setup/status')).json()).hasUsers, false);
  await api(fixture, '/health');
  await setup(fixture);
});

test('replacement rollback preserves media root directories for mounted storage', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kept-backup-swap-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stage = path.join(directory, 'stage'), uploads = path.join(directory, 'uploads'), attachments = path.join(directory, 'attachments');
  for (const name of [stage, uploads, attachments, path.join(stage, 'uploads'), path.join(stage, 'attachments')]) await fs.mkdir(name, { recursive: true });
  const database = path.join(directory, 'live.sqlite');
  await fs.writeFile(database, 'previous database'); await fs.writeFile(path.join(stage, 'kept.sqlite'), 'new database');
  await fs.writeFile(path.join(uploads, 'old.png'), 'old image'); await fs.writeFile(path.join(stage, 'uploads', 'new.png'), 'new image');
  const inode = (await fs.stat(uploads)).ino;
  const replacements = await stageReplacements({ stage, dbPath: database, uploadDir: uploads, attachmentDir: attachments, full: true });
  try {
    await installReplacements(replacements);
    assert.equal((await fs.stat(uploads)).ino, inode);
    assert.equal(await fs.readFile(database, 'utf8'), 'new database');
    await rollbackReplacements(replacements);
    assert.equal(await fs.readFile(database, 'utf8'), 'previous database');
    assert.equal(await fs.readFile(path.join(uploads, 'old.png'), 'utf8'), 'old image');
  } finally { await cleanupReplacements(replacements); }
  assert.deepEqual(await fs.readdir(uploads), ['old.png']);
});
