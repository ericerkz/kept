const test = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('system appearance defaults, manual overrides and legacy account migration', async () => {
  const fixture = await startFixture();
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  let token;
  async function request(route, { method = 'GET', body, status = 200 } = {}) {
    const response = await fetch(fixture.origin + '/api' + route, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }
  try {
    const setup = await request('/setup/admin', { method: 'POST', body: credentials, status: 201 });
    assert.equal(setup.user.followSystemTheme, true);
    assert.equal(setup.user.theme, 'light', 'legacy theme field remains light/dark');
    token = (await request('/auth/login', { method: 'POST', body: credentials })).token;

    // Old mobile clients only send theme: their explicit choice must still win.
    const manual = await request('/users/me/preferences', { method: 'PATCH', body: { theme: 'dark' } });
    assert.equal(manual.followSystemTheme, false);
    assert.equal(manual.theme, 'dark');
    const automatic = await request('/users/me/preferences', { method: 'PATCH', body: { followSystemTheme: true } });
    assert.equal(automatic.followSystemTheme, true);
    assert.equal(automatic.theme, 'dark', 'automatic mode does not overwrite the saved manual theme');
    const unrelated = await request('/users/me/preferences', { method: 'PATCH', body: { showPastReminders: true } });
    assert.equal(unrelated.followSystemTheme, true);
    await request('/users/me/preferences', { method: 'PATCH', body: { followSystemTheme: 'true', theme: 'light' }, status: 400 });
    const unchanged = await request('/users/me/preferences');
    assert.equal(unchanged.theme, 'dark', 'invalid preference updates must be atomic');
    assert.equal(unchanged.followSystemTheme, true);
    await request('/users/me/preferences', { method: 'PATCH', body: { theme: 'system' }, status: 400 });
    await fixture.restart();
    assert.equal((await request('/users/me/preferences')).followSystemTheme, true);

    await request('/users', { method: 'POST', body: { ...credentials, username: 'legacy-light' }, status: 201 });
    // Reproduce a pre-feature database, with both light and dark accounts.
    await fixture.sql('ALTER TABLE users DROP COLUMN followSystemTheme');
    await fixture.restart();
    const migrated = await fixture.sql('SELECT username, theme, followSystemTheme FROM users ORDER BY id');
    assert.deepEqual(migrated.map(user => [user.theme, user.followSystemTheme]), [['dark', 0], ['light', 0]]);
    const fresh = await request('/users', { method: 'POST', body: { ...credentials, username: 'new-user' }, status: 201 });
    assert.equal(fresh.followSystemTheme, true, 'new accounts opt in after an old database is migrated');
    const login = await request('/auth/login', { method: 'POST', body: credentials });
    assert.equal(login.user.theme, 'dark');
    assert.equal(login.user.followSystemTheme, false);
  } finally {
    await fixture.close();
  }
});
