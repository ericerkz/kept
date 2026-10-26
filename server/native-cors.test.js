const test = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

async function preflight(fixture, origin) {
  return fetch(fixture.origin + '/api/auth/login', {
    method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization'
    }
  });
}

test('default CORS allows exact native origins without cookies, and still requires API authentication', async t => {
  const fixture = await startFixture({ env: { KEPT_CORS_ORIGINS: '', KEPT_CORS_ALLOW_ALL: '' } });
  t.after(() => fixture.close());
  for (const origin of ['https://localhost', 'http://localhost', 'capacitor://localhost', 'ionic://localhost']) {
    const response = await preflight(fixture, origin);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.match(response.headers.get('access-control-allow-headers'), /authorization/i);
    assert.match(response.headers.get('access-control-allow-headers'), /content-type/i);
    assert.match(response.headers.get('vary'), /Origin/);
  }
  for (const origin of ['https://untrusted.test', 'https://localhost.untrusted.test', 'https://localhost:444', 'http://localhost:4200', 'capacitor://other', 'null']) {
    const response = await preflight(fixture, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), null, origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  }
  async function request(route, { body, headers = {}, status = 200 } = {}) {
    const response = await fetch(fixture.origin + route, {
      method: body ? 'POST' : 'GET',
      headers: { Origin: 'https://localhost', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.status, status, `${route}: ${await response.clone().text()}`);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    return response;
  }
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  await request('/api/setup/admin', { body: credentials, status: 201 });
  await request('/api/notes', { status: 401 });
  await request('/api/auth/login', { body: { ...credentials, password: 'wrong' }, status: 401 });
  const login = await request('/api/auth/login', { body: credentials });
  assert.equal(login.headers.get('set-cookie'), null);
  const { token } = await login.json();
  assert.ok(token);
  await request('/api/notes', { headers: { Authorization: `Bearer ${token}` } });
  // Native-origin CORS permission does not bypass the browser CSRF check.
  await request('/api/auth/browser/login', { body: credentials, status: 403 });
});

test('wildcard CORS and explicit credentialed allowlists retain their behavior and precedence', async t => {
  for (const explicit of [false, true]) {
    await t.test(explicit ? 'explicit allowlist overrides wildcard mode' : 'wildcard mode', async t => {
      const fixture = await startFixture({ env: {
        KEPT_CORS_ALLOW_ALL: '1', KEPT_CORS_ORIGINS: explicit ? 'https://app.example.test' : ''
      } });
      t.after(() => fixture.close());
      for (const origin of ['https://localhost', 'https://app.example.test']) {
        const response = await preflight(fixture, origin);
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('access-control-allow-origin'), explicit ? origin : '*');
        assert.equal(response.headers.get('access-control-allow-credentials'), explicit ? 'true' : null);
      }
      const response = await preflight(fixture, 'https://untrusted.test');
      assert.equal(response.headers.get('access-control-allow-origin'), explicit ? null : '*');
    });
  }
});
