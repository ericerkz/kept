// node --test server/upload-request-timeout.test.js
// Issue #185: Node's single 5-minute requestTimeout cut off large Takeout
// uploads, and raising it for everyone would let any client hold a connection
// open by trickling a body. Every request now has 5 minutes; the Takeout
// import, initial restore and encryption removal, after their route's checks,
// have up to an hour while data keeps arriving.
// An interrupted Takeout upload is logged as one explanatory line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const { createRequestDeadlines, REQUEST_BODY_MS, LARGE_UPLOAD_MS, UPLOAD_STALL_MS } = require('./request-deadlines');
const { startFixture } = require('../test-support/session-fixture.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function serve(limits) {
  const deadlines = createRequestDeadlines(limits);
  const cutOff = [];
  const app = express();
  app.use(deadlines.requestBodyDeadline);
  const read = (req, res) => {
    let size = 0;
    req.on('data', chunk => { size += chunk.length; });
    req.on('end', () => res.json({ size }));
    req.on('close', () => { if (!req.complete) cutOff.push(req.bodyDeadline); });
  };
  app.post('/form', read);
  app.post('/upload', deadlines.allowLargeUpload, read);
  // Answers without reading the body, as requireAuth does for a bad token.
  app.post('/reject', (_req, res) => res.status(401).json({}));
  app.post('/listeners', (req, res) => { req.resume(); req.on('end', () => res.json({ close: req.socket.listenerCount('close'), end: req.listenerCount('end') })); });
  const server = http.createServer({ requestTimeout: 0, headersTimeout: 60_000 }, app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, cutOff, close: () => new Promise(resolve => server.close(resolve)) };
}

// Sends `chunks` pieces of 16 bytes, one every `everyMs`; resolves with the
// response status, or the error if the server closed the connection.
function send(port, path, { chunks, everyMs, stallAfter = Infinity, agent }) {
  return new Promise(resolve => {
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunks * 16) } });
    req.on('response', response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body || '{}'), ms: Date.now() - started }));
    });
    req.on('error', error => resolve({ error: error.code || error.message, ms: Date.now() - started }));
    let sent = 0;
    const next = () => {
      if (req.destroyed) return;
      if (sent === stallAfter) return; // stop sending, as a dead link would
      req.write(Buffer.alloc(16));
      if (++sent < chunks) setTimeout(next, everyMs);
      else req.end();
    };
    next();
  });
}

test('the limits are five minutes for any request and an hour for large uploads that keep moving', () => {
  assert.equal(REQUEST_BODY_MS, 5 * 60 * 1000, 'Node\'s own default for every request');
  assert.equal(LARGE_UPLOAD_MS, 60 * 60 * 1000);
  assert.equal(UPLOAD_STALL_MS, 2 * 60 * 1000);
});

test('an ordinary request must arrive in full within the request limit', async t => {
  const app = await serve({ bodyMs: 300, uploadMs: 5000, stallMs: 1000 });
  t.after(app.close);
  const quick = await send(app.port, '/form', { chunks: 4, everyMs: 10 });
  assert.equal(quick.status, 200);
  assert.equal(quick.body.size, 64);
  const trickled = await send(app.port, '/form', { chunks: 20, everyMs: 100 });
  assert.ok(trickled.error, JSON.stringify(trickled));
  assert.ok(trickled.ms < 1500, `cut off after ${trickled.ms} ms`);
  await wait(50);
  assert.deepEqual(app.cutOff, ['request']);
});

test('an upload may outlast the request limit while data keeps arriving', async t => {
  const app = await serve({ bodyMs: 300, uploadMs: 5000, stallMs: 400 });
  t.after(app.close);
  const moving = await send(app.port, '/upload', { chunks: 12, everyMs: 100 });
  assert.equal(moving.status, 200, JSON.stringify(moving));
  assert.equal(moving.body.size, 12 * 16);
  assert.ok(moving.ms > 900, 'it took longer than the ordinary limit');
  assert.deepEqual(app.cutOff, []);
});

test('an upload that stops sending is cut off once it has stalled', async t => {
  const app = await serve({ bodyMs: 300, uploadMs: 5000, stallMs: 400 });
  t.after(app.close);
  const stalled = await send(app.port, '/upload', { chunks: 50, everyMs: 50, stallAfter: 5 });
  assert.ok(stalled.error, JSON.stringify(stalled));
  assert.ok(stalled.ms >= 400 && stalled.ms < 2000, `cut off after ${stalled.ms} ms`);
  await wait(50);
  assert.deepEqual(app.cutOff, ['stalled']);
});

test('an upload still has an overall limit', async t => {
  const app = await serve({ bodyMs: 200, uploadMs: 700, stallMs: 400 });
  t.after(app.close);
  const endless = await send(app.port, '/upload', { chunks: 40, everyMs: 100 });
  assert.ok(endless.error, JSON.stringify(endless));
  assert.ok(endless.ms >= 700 && endless.ms < 1800, `cut off after ${endless.ms} ms`);
  await wait(50);
  assert.deepEqual(app.cutOff, ['upload']);
});

test('finished requests leave nothing behind on a reused connection', async t => {
  const app = await serve({ bodyMs: 200, uploadMs: 400, stallMs: 150 });
  t.after(app.close);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  assert.equal((await send(app.port, '/upload', { chunks: 2, everyMs: 10, agent })).status, 200);
  assert.equal((await send(app.port, '/form', { chunks: 2, everyMs: 10, agent })).status, 200);
  await wait(500); // past every limit of the requests above
  const reused = await send(app.port, '/form', { chunks: 2, everyMs: 10, agent });
  assert.equal(reused.status, 200, JSON.stringify(reused));
  assert.deepEqual(app.cutOff, []);
});

test('an early answer does not let the client keep the connection open by trickling the body', async t => {
  const app = await serve({ bodyMs: 300, uploadMs: 5000, stallMs: 1000 });
  t.after(app.close);
  const outcome = await new Promise(resolve => {
    const started = Date.now();
    let status = '', timer;
    const socket = net.connect(app.port, '127.0.0.1', () => {
      socket.write('POST /reject HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: 100000\r\n\r\n');
      timer = setInterval(() => socket.write(Buffer.alloc(16)), 100); // about 600 s at this pace
    });
    socket.on('data', chunk => { status ||= String(chunk).split('\r\n')[0]; });
    socket.on('error', () => {});
    socket.on('close', () => { clearInterval(timer); resolve({ status, ms: Date.now() - started }); });
    setTimeout(() => socket.destroy(), 3000);
  });
  assert.match(outcome.status, / 401 /);
  assert.ok(outcome.ms < 1500, `the server closed it after ${outcome.ms} ms`);
});

test('keep-alive connections do not collect listeners request after request', async t => {
  const app = await serve({ bodyMs: 1000, uploadMs: 5000, stallMs: 1000 });
  t.after(app.close);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const counts = [];
  for (let i = 0; i < 15; i++) counts.push((await send(app.port, '/listeners', { chunks: 1, everyMs: 0, agent })).body.close);
  assert.equal(counts.at(-1), counts[1], JSON.stringify(counts));
});

test('the server applies the request limit first, and the upload limit only to large uploads after their checks', () => {
  const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  assert.match(source, /http\.createServer\(\{ requestTimeout: 0, headersTimeout: 60_000 \}, app\)/);
  assert.doesNotMatch(source, /KEPT_REQUEST_TIMEOUT_MINUTES/, 'not configurable');
  const firstMiddleware = source.indexOf('app.use(');
  assert.equal(source.indexOf('app.use(requestDeadlines.requestBodyDeadline)'), firstMiddleware, 'mounted before anything reads a body');
  assert.ok(source.includes("app.post('/api/import/google-takeout', requireAuth, importLimiter, allowLargeUpload, googleTakeoutUpload"), 'Takeout: after sign-in');
  const restore = source.slice(source.indexOf("app.post('/api/setup/restore'"));
  assert.ok(restore.indexOf('allowLargeUpload(req, res)') > restore.indexOf('Initial setup already complete.'), 'restore: after its setup checks');
  assert.ok(restore.indexOf('allowLargeUpload(req, res)') < restore.indexOf('restoreUpload(req, res'));
  const removal = fs.readFileSync(require.resolve('./encrypted-note-removal.js'), 'utf8');
  assert.ok(removal.indexOf('allowLargeUpload(req, res)') > removal.indexOf('Only the note owner can remove encryption in Kept.'), 'removal: after the owner check');
  assert.ok(removal.indexOf('allowLargeUpload(req, res)') < removal.indexOf("uploadAttachment.array('files'"));
  // Single files fit in the ordinary limit: images and attachments don't get the long one.
  assert.ok(source.includes("app.post('/api/uploads/images', requireAuth, upload.single('image')"));
  assert.ok(source.includes("app.post('/api/notes/:noteId/attachments', requireAuth, uploadAttachment.single('file')"));
  assert.equal(source.match(/allowLargeUpload/g).length, 4, 'only Takeout, restore and encryption removal get the long limit');
});

test('an interrupted Takeout upload is explained in one log line', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const post = async (path, body, token) => (await fetch(`${fixture.origin}/api${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
  await post('/setup/admin', { username: 'admin', password: 'TimeoutPass123!' });
  const { token } = await post('/auth/login', { username: 'admin', password: 'TimeoutPass123!' });

  const boundary = 'kept-timeout-boundary';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="takeout"; filename="takeout.zip"\r\nContent-Type: application/zip\r\n\r\n`;
  const { port } = new URL(fixture.origin);
  await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/import/google-takeout', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(50 * 1024 * 1024)
    } });
    req.on('error', resolve);
    req.on('close', resolve);
    req.write(head);
    req.write(Buffer.alloc(64 * 1024));
    setTimeout(() => req.destroy(), 500); // the browser tab closes mid-upload
  });

  for (let i = 0; i < 50 && !/Upload interrupted/.test(fixture.output); i++) await wait(100);
  assert.match(fixture.output, /\[Takeout import\] Upload interrupted after [\d.]+ min, .* of 50 MB received\. The connection was closed before the ZIP finished uploading \(by the browser, a proxy or the network\)\./);
  assert.doesNotMatch(fixture.output, /Error: Request aborted\s+at /, 'no multer stack trace');
  assert.equal((await fetch(`${fixture.origin}/api/health`)).status, 200, 'the server is still healthy');
});
