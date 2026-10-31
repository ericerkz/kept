const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequestLimits, createExclusiveTask } = require('./request-limits');
const { startFixture } = require('../test-support/session-fixture.cjs');

function response() {
  return { code: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('account budgets span devices, separate users behind a proxy, and reset after expiry', () => {
  let now = 1000;
  const limits = createRequestLimits({ now: () => now });
  const limited = limits.rateLimit({ key: 'import', perUser: true, windowMs: 5000, max: 2 });
  let accepted = 0;
  const call = (id, ip) => { const res = response(); limited({ user: { id }, ip }, res, () => accepted++); return res; };
  assert.equal(call(1, 'one').code, 200);
  assert.equal(call(1, 'two').code, 200);
  const denied = call(1, 'three');
  assert.equal(denied.code, 429);
  assert.equal(denied.headers['Retry-After'], '5');
  assert.equal(call(2, 'one').code, 200);
  now += 5000; limits.prune();
  assert.equal(call(1, 'one').code, 200);
  assert.equal(accepted, 4);
});

test('existing unauthenticated limits remain IP-scoped', () => {
  const { rateLimit } = createRequestLimits();
  const limited = rateLimit({ key: 'login', windowMs: 1000, max: 1 });
  const call = ip => { const res = response(); limited({ ip }, res, () => {}); return res.code; };
  assert.equal(call('one'), 200); assert.equal(call('one'), 429); assert.equal(call('two'), 200);
});

test('backup exclusion holds until work finishes and releases after an error', async () => {
  const run = createExclusiveTask('Another backup is running.');
  let release;
  const pending = run(() => new Promise(resolve => { release = resolve; }), {}, response());
  const denied = response();
  await run(() => { throw Error('must not run'); }, {}, denied);
  assert.equal(denied.code, 409);
  release(); await pending;
  await assert.rejects(run(async () => { throw Error('disk failure'); }, {}, response()), /disk failure/);
  const next = response(); await run(async () => { next.body = 'done'; }, {}, next);
  assert.equal(next.body, 'done');
});

test('limited imports and credential changes do not block other users, autosaves, sync or uploads', { timeout: 15000 }, async t => {
  const fixture = await startFixture(); t.after(() => fixture.close());
  const password = 'rate-limit-regression-password';
  async function api(route, { token, method = 'GET', body, headers = {} } = {}) {
    return fetch(fixture.origin + '/api' + route, { method, headers: { ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {})
    }, body: body ? JSON.stringify(body) : undefined });
  }
  await api('/setup/admin', { method: 'POST', body: { username: 'limit-owner', password } });
  const token = (await (await api('/auth/login', { method: 'POST', body: { username: 'limit-owner', password } })).json()).token;
  await api('/users', { token, method: 'POST', body: { username: 'limit-member', password, role: 'user' } });
  const member = (await (await api('/auth/login', { method: 'POST', body: { username: 'limit-member', password } })).json()).token;
  for (let i = 0; i < 6; i++) assert.equal((await api('/import/google-takeout', { token, method: 'POST' })).status, 400);
  const denied = await api('/import/google-takeout', { token, method: 'POST' });
  assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  assert.equal((await api('/import/google-takeout', { token: member, method: 'POST' })).status, 400);
  for (let i = 0; i < 10; i++) assert.equal((await api('/users/me/password', { token, method: 'PATCH',
    headers: { 'X-Forwarded-For': `198.51.100.${i}` }, body: { currentPassword: 'wrong', newPassword: password } })).status, 400);
  assert.equal((await api('/users/me/password', { token, method: 'PATCH', body: { currentPassword: 'wrong', newPassword: password } })).status, 429);
  assert.equal((await api('/users/me/password', { token: member, method: 'PATCH', body: { currentPassword: 'wrong', newPassword: password } })).status, 400);
  const note = await (await api('/notes', { token, method: 'POST', body: { noteTitle: 'Autosaving' } })).json();
  for (let i = 0; i < 20; i++) assert.equal((await api(`/notes/${note.id}`, { token, method: 'PATCH', body: { noteTitle: `Edit ${i}` } })).status, 204);
  assert.equal((await api('/sync/changes?since=0', { token })).status, 200);
  const form = new FormData(); form.append('image', new Blob(['image'], { type: 'image/png' }), 'image.png');
  assert.equal((await fetch(fixture.origin + '/api/uploads/images', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })).status, 201);
  await fixture.sql("INSERT OR REPLACE INTO app_settings(key,value) VALUES('selfRegistrationEnabled','true')");
  const invalidEmail = await api('/auth/register', { method: 'POST', body: {
    username: 'invalid-email', password, email: 'a@' + '.'.repeat(100_000) + '@'
  } });
  assert.equal(invalidEmail.status, 400);
  const invalidPlace = await api('/location-saved-places', { token, method: 'POST', body: {
    name: '<style>'.repeat(50_000), address: 'test', latitude: 43, longitude: -79
  } });
  assert.equal(invalidPlace.status, 400);
  assert.equal((await api('/health')).status, 200);
});
