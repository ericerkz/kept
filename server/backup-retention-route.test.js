// node --test server/backup-retention-route.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('admins can set a backup retention policy and it prunes old backups', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const password = 'backup-retention-password';
  async function api(pathname, body, token, method = body === undefined ? 'GET' : 'POST', status = 200) {
    const response = await fetch(`${fixture.origin}/api${pathname}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }
  await api('/setup/admin', { username: 'admin', password }, undefined, 'POST', 201);
  const admin = (await api('/auth/login', { username: 'admin', password })).token;
  await api('/users', { username: 'member', password }, admin, 'POST', 201);
  const member = (await api('/auth/login', { username: 'member', password })).token;

  const backupDir = path.join(fixture.directory, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = days => new Date(Date.now() - days * 86400000).toISOString().replace(/[:.]/g, '-');
  const scheduled = [0, 1, 2, 3, 4].map(days => `backup-${stamp(days)}.sqlite`);
  const manualCopy = `backup-${stamp(9)}-manual.sqlite`;
  for (const name of [...scheduled, manualCopy, 'notes.txt']) fs.writeFileSync(path.join(backupDir, name), 'x');

  assert.deepEqual((await api('/admin/backup/status', undefined, admin)).retention, { mode: 'all', includeManual: false });

  await t.test('only admins can change it, and bad policies are rejected', async () => {
    await api('/admin/backup/retention', { retention: { mode: 'count', keepLast: 1 } }, member, 'POST', 403);
    await api('/admin/backup/retention', { retention: { mode: 'count', keepLast: 0 } }, admin, 'POST', 400);
    assert.equal(fs.readdirSync(backupDir).length, 7);
  });

  await t.test('keeping the newest 2 removes older scheduled backups only', async () => {
    const result = await api('/admin/backup/retention', { retention: { mode: 'count', keepLast: 2 } }, admin);
    assert.deepEqual(result.retention, { mode: 'count', keepLast: 2, includeManual: false });
    assert.deepEqual(result.deleted.sort(), scheduled.slice(2).sort());
    assert.deepEqual(fs.readdirSync(backupDir).sort(), [...scheduled.slice(0, 2), manualCopy, 'notes.txt'].sort());
    assert.deepEqual((await api('/admin/backup/status', undefined, admin)).retention, result.retention);
  });

  await t.test('a manual backup applies the policy again', async () => {
    await api('/admin/backup/retention', { retention: { mode: 'count', keepLast: 1, includeManual: true } }, admin);
    assert.deepEqual(fs.readdirSync(backupDir).sort(), [scheduled[0], manualCopy, 'notes.txt'].sort());
    const created = await api('/admin/backup/now', {}, admin);
    const files = fs.readdirSync(backupDir).sort();
    // The new manual copy replaces the older one; unrelated files are untouched.
    assert.deepEqual(files, [scheduled[0], created.filename, 'notes.txt'].sort());
  });
});
