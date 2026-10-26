const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('HttpOnly browser sessions, CSRF, revocation and native bearer compatibility', async () => {
  const fixture = await startFixture();
  const base = fixture.origin;
  let cookie = '', csrf = '';
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  async function request(route, { method = 'GET', body, headers = {}, browser = true, status = 200 } = {}) {
    const response = await fetch(base + route, {
      method, headers: { ...(browser ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.status, status, `${route}: ${await response.clone().text()}`);
    if (browser && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  async function login() {
    const anonymous = await request('/api/auth/browser/session');
    csrf = (await anonymous.json()).csrfToken;
    const response = await request('/api/auth/browser/login', { method: 'POST', body: credentials });
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    const result = await response.json();
    assert.equal(result.token, undefined);
    csrf = result.csrfToken;
    return result;
  }
  const socket = async (url, headers, expected, token) => {
    const ws = new WebSocket(base.replace('http', 'ws') + url, { headers });
    ws.on('message', data => {
      if (JSON.parse(data).type === 'auth-required') {
        if (token) ws.send(JSON.stringify({ type: 'authenticate', token }));
        else ws.send(JSON.stringify({ type: 'authenticate', token: '' }));
      }
    });
    try {
      if (expected === 'ready') {
        let message;
        do { const [data] = await once(ws, 'message', { signal: AbortSignal.timeout(5000) }); message = JSON.parse(data); } while (message.type === 'auth-required');
        assert.equal(message.type, 'ready');
      } else {
        const [code] = await once(ws, 'close', { signal: AbortSignal.timeout(5000) });
        assert.equal(code, 1008);
      }
    } finally { ws.close(); }
  };
  try {
    await request('/api/setup/admin', { method: 'POST', body: credentials, browser: false, status: 201 });
    await request('/api/auth/browser/login', { method: 'POST', body: credentials, status: 403 });
    const result = await login();
    await request('/api/notes', { browser: false, headers: { 'X-CSRF-Token': csrf }, status: 401 });
    const beforeRestart = cookie;
    const refresh = await (await request('/api/auth/browser/session')).json();
    assert.equal(refresh.authenticated, true);
    assert.equal(refresh.user.id, result.user.id);
    assert.equal(refresh.token, undefined);
    await request('/api/notes');
    await request('/api/notes', { method: 'POST', body: { noteTitle: 'CSRF blocked' }, headers: { 'X-CSRF-Token': '' }, status: 403 });
    await request('/api/notes', { method: 'POST', body: { noteTitle: 'Header cannot bypass CSRF' }, headers: { Authorization: 'invalid' }, status: 401 });
    const note = await (await request('/api/notes', { method: 'POST', body: { noteTitle: 'Cookie note', noteBody: '<b>Body</b>', checkBoxes: [], labels: [], images: [] }, status: 201 })).json();
    assert.ok(note.id);
    await socket('/api/realtime', { Cookie: cookie, Origin: base }, 'ready');
    await socket('/api/realtime', { Cookie: cookie, Origin: 'https://evil.example' }, 'rejected');
    await socket('/api/realtime', { Cookie: cookie, Origin: 'https://localhost' }, 'rejected');
    await socket('/api/realtime', { Cookie: cookie }, 'rejected');
    await fixture.restart();
    await request('/api/notes');
    assert.equal(cookie, beforeRestart, 'browser session must persist across restarts');

    const nativeResponse = await request('/api/auth/login', { browser: false, method: 'POST', body: credentials });
    assert.equal(nativeResponse.headers.get('set-cookie'), null, 'native login has no cookie dependency');
    const native = await nativeResponse.json();
    assert.ok(native.token);
    const nativeHeaders = { Authorization: `Bearer ${native.token}` };
    for (const origin of ['capacitor://localhost', 'https://localhost']) {
      const capabilities = await request('/api/client/capabilities', { headers: { ...nativeHeaders, Origin: origin }, browser: false });
      assert.equal(capabilities.headers.get('access-control-allow-origin'), origin);
    }
    await request('/api/notes', { method: 'POST', body: { noteTitle: 'Native note' }, headers: nativeHeaders, browser: false, status: 201 });
    await socket('/api/realtime', { Origin: 'capacitor://localhost' }, 'ready', native.token);
    await socket('/api/realtime', { Origin: 'https://localhost' }, 'ready', native.token);
    await socket(`/api/realtime?token=${native.token}`, { Origin: 'capacitor://localhost' }, 'rejected');

    const form = new FormData();
    form.append('image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'drawing.png');
    const upload = await fetch(base + '/api/uploads/images', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: form });
    assert.equal(upload.status, 201);
    const image = await upload.json();
    await request(image.url);
    await request(image.url, { browser: false, headers: nativeHeaders });
    await request(`${image.url}?token=${native.token}`, { browser: false, status: 401 });
    const backup = await (await request('/api/admin/backup/now', { method: 'POST', body: {} })).json();
    assert.ok(backup.filename);
    await request('/api/admin/backup/download/' + backup.filename);
    await request('/api/admin/backup/download/' + backup.filename, { browser: false, headers: nativeHeaders });
    await request('/api/admin/backup/download/' + backup.filename + '?token=' + native.token, { browser: false, status: 401 });

    // SSO codes use the same cookie completion path; native exchange remains
    // covered by the existing end-to-end OIDC provider test.
    const code = 'browser-oidc-test-code';
    await fixture.sql('INSERT INTO oidc_login_codes (codeHash, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)',
      [createHash('sha256').update(code).digest('hex'), result.user.id, new Date().toISOString(), new Date(Date.now() + 60000).toISOString()]);
    const oidc = await (await request('/api/auth/browser/oidc/exchange', { method: 'POST', body: { code } })).json();
    assert.equal(oidc.token, undefined);
    csrf = oidc.csrfToken;
    await request('/api/auth/logout', { method: 'POST', body: {}, status: 204 });
    await request('/api/notes', { status: 401 });
    await request('/api/notes', { browser: false, headers: nativeHeaders });

    // Browser login uses the same 2FA checks and one-use backup codes.
    await fixture.sql('UPDATE users SET totpEnabled = 1, totpBackupCodes = ? WHERE id = ?', [JSON.stringify(['ABCDEFGH']), result.user.id]);
    csrf = (await (await request('/api/auth/browser/session')).json()).csrfToken;
    const requires2fa = await request('/api/auth/browser/login', { method: 'POST', body: credentials, status: 401 });
    assert.equal((await requires2fa.json()).requires2FA, true);
    const with2fa = await (await request('/api/auth/browser/login', { method: 'POST', body: { ...credentials, totpToken: 'ABCDEFGH' } })).json();
    csrf = with2fa.csrfToken;
    assert.equal(with2fa.token, undefined);
    await request('/api/auth/browser/login', { method: 'POST', body: { ...credentials, totpToken: 'ABCDEFGH' }, status: 401 });
    await fixture.sql('UPDATE users SET totpEnabled = 0 WHERE id = ?', [result.user.id]);
    await login();
    await request('/api/users/me/password', { method: 'PATCH', body: { currentPassword: credentials.password, newPassword: 'new-password-123' } });
    credentials.password = 'new-password-123';
    await request('/api/notes');
    await request('/api/notes', { browser: false, headers: nativeHeaders, status: 401 });
    await fixture.sql("UPDATE sessions SET expiresAt = '2000-01-01T00:00:00.000Z'");
    await request('/api/notes', { status: 401 });
    await socket('/api/realtime', { Cookie: cookie, Origin: base }, 'rejected');

    // An old browser credential is exchanged once and revoked immediately.
    const legacy = await (await request('/api/auth/login', { browser: false, method: 'POST', body: credentials })).json();
    csrf = (await (await request('/api/auth/browser/session')).json()).csrfToken;
    const migrated = await (await request('/api/auth/browser/adopt', { method: 'POST', body: {}, headers: { Authorization: `Bearer ${legacy.token}` } })).json();
    assert.equal(migrated.token, undefined);
    csrf = migrated.csrfToken;
    await request('/api/notes');
    await request('/api/notes', { browser: false, headers: { Authorization: `Bearer ${legacy.token}` }, status: 401 });

    await fixture.sql('UPDATE users SET enabled = 0 WHERE id = ?', [result.user.id]);
    await request('/api/notes', { status: 401 });
    await socket('/api/realtime', { Cookie: cookie, Origin: base }, 'rejected');

    cookie = '';
    const secure = await request('/api/auth/browser/session', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(secure.headers.get('set-cookie'), /; Secure/);
  } finally { await fixture.close(); }
});
