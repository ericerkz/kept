const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('URL credentials are rejected; header media and authenticated realtime frames work', async () => {
  const fixture = await startFixture();
  const base = fixture.origin;
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  const post = (route, body, token) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
  });
  const connect = (firstFrame, { query = '', idle = false } = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/realtime' + query, { origin: 'capacitor://localhost' });
    const messages = [];
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Realtime test timed out.')); }, 8000);
    ws.on('error', reject);
    ws.on('message', data => {
      const message = JSON.parse(data);
      messages.push(message.type);
      if (message.type === 'auth-required' && !idle) ws.send(typeof firstFrame === 'string' || Buffer.isBuffer(firstFrame) ? firstFrame : JSON.stringify(firstFrame));
      if (message.type === 'ready') ws.close(1000);
    });
    ws.on('close', code => { clearTimeout(timer); resolve({ code, messages }); });
  });
  try {
    assert.equal((await post('/api/setup/admin', credentials)).status, 201);
    const native = await (await post('/api/auth/login', credentials)).json();
    const headers = { Authorization: `Bearer ${native.token}` };
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64');
    const form = new FormData();
    form.append('image', new Blob([imageBytes], { type: 'image/png' }), 'pixel.png');
    const image = await (await fetch(base + '/api/uploads/images', { method: 'POST', headers, body: form })).json();
    assert.ok(image.url);
    const headerImage = await fetch(base + image.url, { headers });
    assert.equal(headerImage.status, 200);
    assert.deepEqual(Buffer.from(await headerImage.arrayBuffer()), imageBytes);
    const backup = await (await post('/api/admin/backup/now', {}, native.token)).json();
    const backupUrl = '/api/admin/backup/download/' + backup.filename;
    const download = await fetch(base + backupUrl, { headers });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('cache-control'), /private.*no-store/);
    assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');

    for (const route of [image.url, backupUrl, '/api/proxy-image?url=http%3A%2F%2F127.0.0.1%2Fprivate']) {
      const separator = route.includes('?') ? '&' : '?';
      for (const suffix of [`token=${native.token}`, 'token=', 'token[]=anything']) {
        assert.equal((await fetch(base + route + separator + suffix)).status, 401);
        assert.equal((await fetch(base + route + separator + suffix, { headers })).status, 401, 'explicit headers must not enable legacy URL credentials');
      }
    }
    assert.equal((await fetch(base + '/api/notes', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/notes?token=' + native.token)).status, 401);

    const valid = await connect({ type: 'authenticate', token: native.token });
    assert.equal(valid.code, 1000);
    assert.ok(valid.messages.includes('ready'));
    const legacy = await connect(null, { query: '?token=' + native.token });
    assert.equal(legacy.code, 1008);
    assert.deepEqual(legacy.messages, []);
    for (const frame of [
      { type: 'join-note', noteId: 1 }, { type: 'authenticate', token: 'invalid' },
      { type: 'authenticate', token: [native.token] }, 'not json', Buffer.from('binary'), 'x'.repeat(4097)
    ]) {
      const rejected = await connect(frame);
      assert.equal(rejected.code, 1008);
      assert.ok(!rejected.messages.includes('ready'), 'application access requires authentication');
    }
    const idle = await connect(null, { idle: true });
    assert.equal(idle.code, 1008);
    assert.deepEqual(idle.messages, ['auth-required']);
    const oversized = await connect('x'.repeat(65537));
    assert.ok([1006, 1009].includes(oversized.code));
    assert.equal((await fetch(base + '/api/notes', { headers })).status, 200, 'malformed frames must not crash the server');
    await post('/api/auth/logout', {}, native.token);
    assert.equal((await fetch(base + image.url, { headers })).status, 401);
    assert.equal((await connect({ type: 'authenticate', token: native.token })).code, 1008);
  } finally { await fixture.close(); }
});
