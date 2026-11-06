const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { SECRET_ENV_NAMES, loadSecretFiles } = require('./secret-files');
const { startFixture } = require('../test-support/session-fixture.cjs');

function files(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-secret-files-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return (name, contents) => {
    const filename = path.join(directory, name);
    fs.writeFileSync(filename, contents, { mode: 0o600 });
    return filename;
  };
}

test('all supported file settings resolve without changing environment variables', t => {
  const file = files(t);
  const env = Object.fromEntries(SECRET_ENV_NAMES.map(name => [`${name}_FILE`, file(name, ` ${name} value \r\n`)]));
  env.UNRELATED_FILE = '/not/read';
  const before = { ...env };
  const values = loadSecretFiles(env);
  for (const name of SECRET_ENV_NAMES) assert.equal(values[name], ` ${name} value `);
  assert.deepEqual(env, before);
  assert.ok(Object.isFrozen(values));
});

test('line endings, meaningful spaces, empty direct placeholders and mounted symlinks work', t => {
  const file = files(t);
  const target = file('secret', '  password with spaces  \n\r\n');
  const link = path.join(path.dirname(target), 'mounted-secret');
  fs.symlinkSync(target, link);
  assert.equal(loadSecretFiles({ KEPT_SMTP_PASS: '', KEPT_SMTP_PASS_FILE: link }).KEPT_SMTP_PASS, '  password with spaces  ');
  assert.equal(Object.keys(loadSecretFiles({ KEPT_SMTP_PASS: 'existing', KEPT_SMTP_PASS_FILE: '' })).length, 0);
});

test('invalid files and conflicting sources fail without exposing secret contents or paths', t => {
  const file = files(t);
  const setting = 'KEPT_OIDC_CLIENT_SECRET_FILE';
  const sensitive = 'do-not-print-this-value';
  const target = file('secret', sensitive);
  assert.throws(() => loadSecretFiles({ KEPT_OIDC_CLIENT_SECRET: sensitive, [setting]: target }), error => {
    assert.match(error.message, /Set either KEPT_OIDC_CLIENT_SECRET or KEPT_OIDC_CLIENT_SECRET_FILE, not both/);
    assert.ok(!error.message.includes(sensitive));
    return true;
  });
  const invalid = [
    `${target}-missing`, path.dirname(target),
    file('empty', ''), file('newlines', '\r\n'),
    file('nul', `${sensitive}\0`), file('invalid-utf8', Buffer.from([0xff, 0xfe])),
    file('oversized', 'x'.repeat(64 * 1024 + 1))
  ];
  if (process.getuid?.() !== 0) {
    const unreadable = file('unreadable', sensitive);
    fs.chmodSync(unreadable, 0o000);
    invalid.push(unreadable);
  }
  for (const filename of invalid) {
    assert.throws(() => loadSecretFiles({ [setting]: filename }), error => {
      assert.match(error.message, /KEPT_OIDC_CLIENT_SECRET_FILE.*readable, non-empty UTF-8/);
      assert.ok(!error.message.includes(sensitive));
      assert.ok(!error.message.includes(filename));
      return true;
    });
  }
});

test('files are read once and direct credentials retain their existing behavior', t => {
  const file = files(t);
  const filename = file('password', 'first password\n');
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { secretValue } = require('./server/secret-files');
    assert.equal(secretValue('KEPT_SMTP_PASS'), 'first password');
    assert.equal(process.env.KEPT_SMTP_PASS, undefined);
    fs.writeFileSync(process.env.KEPT_SMTP_PASS_FILE, 'changed password');
    assert.equal(secretValue('KEPT_SMTP_PASS'), 'first password');
    assert.equal(secretValue('KEPT_SMTP_USER'), 'existing-user');
    assert.equal(secretValue('KEPT_OIDC_CLIENT_SECRET'), 'existing-secret');
    console.log('ok');
  `], { encoding: 'utf8', env: { ...process.env, KEPT_SMTP_PASS: undefined, KEPT_SMTP_PASS_FILE: filename,
    KEPT_SMTP_USER: 'existing-user', KEPT_OIDC_CLIENT_SECRET: 'existing-secret' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
});

test('SMTP consumes file-backed credentials without exporting them', t => {
  const file = files(t);
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    let config;
    Module._load = function(name, ...args) {
      if (name === 'nodemailer') return { createTransport(value) { config = value; return {}; } };
      return original.call(this, name, ...args);
    };
    assert.equal(require('./server/mailer').isConfigured(), true);
    assert.deepEqual(config.auth, { user: 'smtp-user', pass: ' smtp-password ' });
    assert.equal(process.env.KEPT_SMTP_PASS, undefined);
    console.log('ok');
  `], { encoding: 'utf8', env: { ...process.env, KEPT_SMTP_HOST: 'smtp.example.test',
    KEPT_SMTP_USER: undefined, KEPT_SMTP_PASS: undefined,
    KEPT_SMTP_USER_FILE: file('user', 'smtp-user\n'), KEPT_SMTP_PASS_FILE: file('pass', ' smtp-password \n') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
});

test('real server uses file-backed setup/metrics tokens, VAPID keys and OIDC client secret', async t => {
  const file = files(t);
  const { startProvider, completeProviderRedirect } = await import('../test-support/oidc-provider.mjs');
  const provider = await startProvider({ clientSecret: ' file-client-secret ' });
  t.after(() => provider.close());
  const keys = require('web-push').generateVAPIDKeys();
  const fixture = await startFixture({ env: {
    KEPT_SETUP_TOKEN: '', KEPT_SETUP_TOKEN_FILE: file('setup', 'setup-secret\n'),
    KEPT_METRICS_TOKEN: '', KEPT_METRICS_TOKEN_FILE: file('metrics', 'metrics-secret\n'),
    VAPID_PUBLIC_KEY: '', VAPID_PUBLIC_KEY_FILE: file('public-key', `${keys.publicKey}\n`),
    VAPID_PRIVATE_KEY: '', VAPID_PRIVATE_KEY_FILE: file('private-key', `${keys.privateKey}\n`),
    KEPT_OIDC_ISSUER: provider.issuer, KEPT_OIDC_CLIENT_ID: 'kept-test',
    KEPT_OIDC_CLIENT_SECRET: '', KEPT_OIDC_CLIENT_SECRET_FILE: file('oidc', ' file-client-secret \r\n')
  } });
  t.after(() => fixture.close());
  const credentials = { username: 'file-secret-owner', password: 'isolated-secret-password' };
  async function request(route, options = {}) { return fetch(`${fixture.origin}/api${route}`, options); }
  const setup = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) };
  assert.equal((await request('/setup/admin', setup)).status, 403);
  assert.equal((await request('/setup/admin', { ...setup, headers: { ...setup.headers, 'X-Kept-Setup-Token': 'setup-secret' } })).status, 201);
  assert.equal((await request('/settings/storage')).status, 401);
  assert.equal((await request('/settings/storage', { headers: { 'X-Kept-Metrics-Token': 'metrics-secret' } })).status, 200);
  const { token } = await (await request('/auth/login', setup)).json();
  const auth = { Authorization: `Bearer ${token}` };
  assert.deepEqual(await (await request('/push/vapid-public-key', { headers: auth })).json(), { publicKey: keys.publicKey });
  const link = await (await request('/auth/oidc/link/start', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).json();
  const callback = await completeProviderRedirect(link.url);
  const redirect = await fetch(callback, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.ok(!redirect.headers.get('location').includes('oidc_error'));
  assert.equal((await (await request('/auth/oidc/link/status', { headers: auth })).json()).connected, true);
});

test('invalid secret configuration stops the server before it creates data', t => {
  const file = files(t);
  const filename = file('secret', 'never-log-this');
  const dataDir = path.join(path.dirname(filename), 'should-not-exist');
  const result = spawnSync(process.execPath, ['server/server.js'], { encoding: 'utf8', env: { ...process.env,
    DATA_DIR: dataDir, KEPT_SETUP_TOKEN: 'never-log-this', KEPT_SETUP_TOKEN_FILE: filename } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set either KEPT_SETUP_TOKEN or KEPT_SETUP_TOKEN_FILE, not both/);
  assert.ok(!result.stderr.includes('never-log-this'));
  assert.equal(fs.existsSync(dataDir), false);
});
