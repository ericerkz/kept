const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('default note colour is validated, account scoped, durable and synchronized without recolouring notes', async () => {
  const fixture = await startFixture();
  let token;
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  async function request(path, body, method = body ? 'POST' : 'GET', status = 200) {
    const response = await fetch(fixture.origin + '/api' + path, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }
  try {
    await request('/setup/admin', credentials, 'POST', 201);
    const login = await request('/auth/login', credentials); token = login.token;
    assert.equal(login.user.defaultNoteColor, '');
    const existing = await request('/notes', { noteTitle: 'Keep original', bgColor: '' }, 'POST', 201);
    assert.equal((await request('/users/me/preferences', { defaultNoteColor: '#D2E3FC' }, 'PATCH')).defaultNoteColor, '#d2e3fc');
    for (const color of [null, {}, 'red', 'url(https://example.com)', '#12345']) {
      await request('/users/me/preferences', { defaultNoteColor: color }, 'PATCH', 400);
    }
    assert.equal((await request('/users/me/preferences')).defaultNoteColor, '#d2e3fc');
    assert.equal((await request(`/notes/${existing.id}`)).bgColor, '');
    const inherited = await request('/notes', { noteTitle: 'New default' }, 'POST', 201);
    assert.equal((await request(`/notes/${inherited.id}`)).bgColor, '#d2e3fc');
    const explicit = await request('/notes', { noteTitle: 'Explicit none', bgColor: '' }, 'POST', 201);
    assert.equal((await request(`/notes/${explicit.id}`)).bgColor, '');
    const other = await request('/users', { ...credentials, username: 'other' }, 'POST', 201);
    assert.equal(other.defaultNoteColor, '');
    assert.equal((await request('/sync/bootstrap?protocolVersion=2')).preferences[0].defaultNoteColor, '#d2e3fc');
    const mutation = color => ({ type: 'preferences.patch', syncId: 'account-preferences', operationId: `colour-${color}`,
      payload: { defaultNoteColor: color }, lww: { physicalMs: Date.now() + 1000, logical: 0, deviceId: 'colour-test', operationId: `colour-${color}` } });
    const synced = await request('/sync/mutations', { protocolVersion: 2, mutations: [mutation('#E8D7FF')] });
    assert.equal(synced.results[0].ok, true);
    assert.equal((await request('/users/me/preferences')).defaultNoteColor, '#e8d7ff');
    const rejected = await request('/sync/mutations', { protocolVersion: 2, mutations: [mutation('invalid')] });
    assert.equal(rejected.results[0].ok, false);
    await fixture.restart();
    assert.equal((await request('/users/me/preferences')).defaultNoteColor, '#e8d7ff');
    await request('/users/me/preferences', { defaultNoteColor: '' }, 'PATCH');
    assert.equal((await request('/users/me/preferences')).defaultNoteColor, '');
  } finally { await fixture.close(); }
});
