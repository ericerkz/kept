const test = require('node:test');
const assert = require('node:assert/strict');
const { startImageProxyFixture } = require('../test-support/image-proxy-fixture');

function assertProtected(response) {
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /(?:^|;)\s*sandbox\s*(?:;|$)/);
  assert.match(policy, /script-src 'none'/);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(policy, /allow-scripts|allow-same-origin/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
}

test('image proxy preserves SVG, inline artwork and raster images with sandboxed, non-cacheable responses', async t => {
  const fixture = await startImageProxyFixture(); t.after(() => fixture.close());
  for (const path of ['/drawing.svg', '/mixed-case.svg', '/redirect']) {
    const response = await fetch(fixture.proxyUrl(path));
    assert.equal(response.status, 200); assertProtected(response);
    assert.match(response.headers.get('content-type'), /image\/svg\+xml/i);
    assert.equal(await response.text(), fixture.svg);
  }
  const png = await fetch(fixture.proxyUrl('/pixel.png'));
  assert.equal(png.status, 200); assertProtected(png);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), fixture.png);
});

test('image proxy applies the same response policy before authentication, on errors and on HEAD requests', async t => {
  const fixture = await startImageProxyFixture(); t.after(() => fixture.close());
  const cases = [
    [`${fixture.baseUrl}/api/proxy-image`, 401],
    [`${fixture.baseUrl}/api/proxy-image?token=attacker-test-token`, 400],
    [`${fixture.baseUrl}/api/proxy-image?token=attacker-test-token&url=not-a-url`, 400],
    [`${fixture.baseUrl}/api/proxy-image?token=attacker-test-token&url=file:///tmp/test`, 400],
    [`${fixture.baseUrl}/api/proxy-image?token=attacker-test-token&url=http://127.0.0.1/private`, 400],
    [fixture.proxyUrl('/html'), 415], [fixture.proxyUrl('/error'), 503]
  ];
  for (const [url, status] of cases) { const response = await fetch(url); assert.equal(response.status, status, url); assertProtected(response); await response.text(); }
  const head = await fetch(fixture.proxyUrl(), { method: 'HEAD' });
  assert.equal(head.status, 200); assertProtected(head); assert.equal(await head.text(), '');
  const headerAuth = new URL(fixture.proxyUrl()); headerAuth.searchParams.delete('token');
  const authenticated = await fetch(headerAuth, { headers: { Authorization: 'Bearer attacker-test-token' } });
  assert.equal(authenticated.status, 200); assertProtected(authenticated); await authenticated.text();
  const home = await fetch(fixture.baseUrl);
  assert.equal(home.headers.get('content-security-policy'), null, 'policy must not restrict the application document');
  await home.text();
});
