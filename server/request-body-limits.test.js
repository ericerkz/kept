// node --test server/request-body-limits.test.js
// Unauthenticated JSON bodies are capped at 64 KB; a resolving session or
// token keeps the 25 MB allowance that notes with inline images need.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

const big = 'x'.repeat(200 * 1024);
const json = (method, body, headers = {}) => ({
  method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test('JSON size allowance depends on a credential that resolves', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const url = path => `${fixture.origin}${path}`;

  assert.equal((await fetch(url('/api/setup/admin'), json('POST', { username: 'admin', password: 'AdminPass123!' }))).status, 201);
  const { token } = await (await fetch(url('/api/auth/login'), json('POST', { username: 'admin', password: 'AdminPass123!' }))).json();
  assert.ok(token);

  await t.test('small unauthenticated bodies still work', async () => {
    const response = await fetch(url('/api/auth/login'), json('POST', { username: 'admin', password: 'wrong' }));
    assert.equal(response.status, 401);
  });

  await t.test('large unauthenticated bodies are rejected before parsing', async () => {
    const response = await fetch(url('/api/auth/login'), json('POST', { username: 'admin', password: 'wrong', pad: big }));
    assert.equal(response.status, 413);
  });

  await t.test('a bearer token that does not resolve gets the public limit', async () => {
    const response = await fetch(url('/api/notes'), json('POST', { noteTitle: 't', noteBody: big }, { authorization: 'Bearer kept_mcp_not-a-real-token' }));
    assert.equal(response.status, 413);
  });

  await t.test('chunked unauthenticated bodies get the public limit', async () => {
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ username: 'admin', pad: big })));
      controller.close();
    } });
    const response = await fetch(url('/api/auth/login'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half'
    });
    assert.equal(response.status, 413);
  });

  await t.test('an authenticated request keeps the large allowance', async () => {
    const response = await fetch(url('/api/notes'), json('POST', {
      noteTitle: 'Large note', noteBody: `<p>${big}</p>`, checkBoxes: [], labels: [], isCbox: false
    }, { authorization: `Bearer ${token}` }));
    assert.equal(response.status, 201);
  });
});
