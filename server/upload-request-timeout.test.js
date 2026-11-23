// node --test server/upload-request-timeout.test.js
// Issue #185: Node's default 5-minute requestTimeout cut off large Takeout
// uploads. The limit is now KEPT_REQUEST_TIMEOUT_MINUTES (default 60), and an
// interrupted upload is logged as one explanatory line instead of a stack.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('a stalled Takeout upload is cut off at KEPT_REQUEST_TIMEOUT_MINUTES and explained in the log', { timeout: 90000 }, async t => {
  // 0.02 minutes = 1.2 s. Node checks request deadlines every 30 s or so.
  const fixture = await startFixture({ env: { KEPT_REQUEST_TIMEOUT_MINUTES: '0.02' } });
  t.after(() => fixture.close());
  const post = async (path, body, token) => (await fetch(`${fixture.origin}/api${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
  await post('/setup/admin', { username: 'admin', password: 'TimeoutPass123!' });
  const { token } = await post('/auth/login', { username: 'admin', password: 'TimeoutPass123!' });

  const boundary = 'kept-timeout-boundary';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="takeout"; filename="takeout.zip"\r\nContent-Type: application/zip\r\n\r\n`;
  const declaredBytes = 50 * 1024 * 1024;
  const { port } = new URL(fixture.origin);
  const outcome = await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/import/google-takeout', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(declaredBytes)
    } });
    const started = Date.now();
    req.on('response', response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode, ms: Date.now() - started })); });
    req.on('error', error => resolve({ error: error.code || error.message, ms: Date.now() - started }));
    req.write(head);
    req.write(Buffer.alloc(64 * 1024)); // then stall, as a slow link would
  });
  // Either Node's 408 or a closed socket, but well before the body could finish.
  assert.ok(outcome.status === 408 || outcome.error, JSON.stringify(outcome));
  assert.ok(outcome.ms < 60000, `cut off after ${outcome.ms} ms`);

  for (let i = 0; i < 50 && !/Upload interrupted/.test(fixture.output); i++) await new Promise(r => setTimeout(r, 100));
  assert.match(fixture.output, /\[Takeout import\] Upload interrupted after [\d.]+ min, .* received\. .*request time limit: 0\.02 min/);
  assert.doesNotMatch(fixture.output, /Error: Request aborted\s+at /, 'no multer stack trace');
  // The server is still healthy afterwards.
  assert.equal((await fetch(`${fixture.origin}/api/health`)).status, 200);
});
