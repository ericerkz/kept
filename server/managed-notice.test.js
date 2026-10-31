const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createManagedNoticePoller } = require('./managed-notice');
const { startFixture } = require('../test-support/session-fixture.cjs');
const HOUR = 3600000;
const ending = { kind: 'ending', endsAt: '2030-01-05T12:00:00.000Z', deletesAt: '2030-04-05T12:00:00.000Z', dismissible: true, actionUrl: 'https://provider.test/account' };

function harness(options = {}) {
  const calls = [], logs = [], timers = new Map(); let now = 0, sequence = 0;
  let respond = async () => new Response(JSON.stringify({ notice: ending }));
  const poller = createManagedNoticePoller({
    managed: true, url: 'https://provider.test/notice', token: 'test-metrics-secret',
    fetchImpl: async (...args) => { calls.push(args); return respond(...args); }, now: () => now,
    setTimer: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id), log: message => logs.push(message), ...options
  });
  return { poller, calls, logs, timers, respond: fn => respond = fn, setNow: value => now = value };
}

test('polling requires all three opt-in settings, including an explicitly managed instance', async () => {
  for (const options of [{ managed: false }, { url: undefined }, { token: '' }, { token: '   ' }]) {
    const h = harness(options); await h.poller.start(); await h.poller.refresh();
    assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.poller.notice, null);
  }
});

test('startup polling sends the monitoring header and switches between hourly and six-hour schedules', async () => {
  const h = harness(); await h.poller.start();
  assert.deepEqual(h.poller.notice, ending);
  const [url, request] = h.calls[0];
  assert.equal(url, 'https://provider.test/notice'); assert.equal(request.method, 'GET');
  assert.equal(request.headers['X-Kept-Metrics-Token'], 'test-metrics-secret');
  assert.equal(request.redirect, 'error'); assert.ok(request.signal instanceof AbortSignal);
  assert.equal([...h.timers.values()][0].delay, HOUR);
  h.respond(async () => new Response(JSON.stringify({ notice: { ...ending, kind: 'payment_problem', endsAt: null, deletesAt: null } })));
  await h.poller.refresh(); assert.equal(h.poller.notice.kind, 'payment_problem'); assert.equal(h.timers.size, 1);
  h.respond(async () => new Response('{"notice":null}'));
  await h.poller.refresh(); assert.equal(h.poller.notice, null); assert.equal([...h.timers.values()][0].delay, 6 * HOUR);
  h.poller.stop(); assert.equal(h.timers.size, 0);
});

test('failed or malformed responses retain the last valid notice and logs are limited to once per hour', async () => {
  const h = harness(); await h.poller.start();
  for (const body of ['invalid JSON', '{}', JSON.stringify({ notice: { ...ending, actionUrl: 'javascript:alert(1)' } }), JSON.stringify({ notice: { ...ending, endsAt: 'invalid' } }), 'x'.repeat(65537)]) {
    h.respond(async () => new Response(body)); await h.poller.refresh(); assert.deepEqual(h.poller.notice, ending);
  }
  assert.equal(h.logs.length, 1); assert.ok(h.logs.every(message => !message.includes('test-metrics-secret')));
  h.setNow(HOUR - 1); h.respond(async () => new Response('', { status: 503 }));
  await h.poller.refresh(); assert.equal(h.logs.length, 1);
  h.setNow(HOUR); await h.poller.refresh(); assert.equal(h.logs.length, 2);
  assert.equal([...h.timers.values()][0].delay, HOUR);
  h.poller.stop();
});

test('polling coalesces concurrent refreshes and the timeout preserves the prior answer', async () => {
  const h = harness(); let release;
  h.respond(() => new Promise(resolve => release = resolve));
  const first = h.poller.start(), second = h.poller.refresh();
  assert.equal(first, second); assert.equal(h.calls.length, 1);
  release(new Response('{"notice":null}')); await first; assert.equal(h.timers.size, 1); h.poller.stop();
  const slow = harness({ timeoutMs: 10 });
  await slow.poller.start();
  slow.respond((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const keepAlive = setTimeout(() => {}, 100);
  try { await slow.poller.refresh(); } finally { clearTimeout(keepAlive); }
  assert.deepEqual(slow.poller.notice, ending); assert.equal(slow.logs.length, 1); slow.poller.stop();
});

test('the public server endpoint exposes notices, and self-hosted/unconfigured instances make no provider request', async () => {
  const hits = [];
  const provider = http.createServer((req, res) => {
    hits.push({ url: req.url, token: req.headers['x-kept-metrics-token'] });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/must-not-receive-token' }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ notice: ending }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  try {
    for (const enabled of [false, true]) {
      const before = hits.length;
      const fixture = await startFixture({ env: {
        KEPT_MANAGED_HOSTING: enabled ? '1' : '0', KEPT_METRICS_TOKEN: 'test-metrics-secret',
        KEPT_MANAGED_NOTICE_URL: `${providerUrl}/notice`, KEPT_MANAGED_PROVIDER_NAME: 'Acme Hosting'
      } });
      try {
        let info;
        for (let attempt = 0; attempt < 20; attempt++) {
          const response = await fetch(fixture.origin + '/api/settings/managed-hosting');
          assert.match(response.headers.get('cache-control'), /no-store/); info = await response.json();
          if (!enabled || info.notice) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.deepEqual(info.notice, enabled ? ending : null);
        assert.equal(hits.length, before + Number(enabled));
        assert.equal(JSON.stringify(info).includes('test-metrics-secret'), false);
        if (enabled) assert.equal(hits.at(-1).token, 'test-metrics-secret');
      } finally { await fixture.close(); }
    }
    const missingToken = await startFixture({ env: { KEPT_MANAGED_HOSTING: '1', KEPT_METRICS_TOKEN: '', KEPT_MANAGED_NOTICE_URL: `${providerUrl}/notice` } });
    const before = hits.length;
    try { assert.equal((await (await fetch(missingToken.origin + '/api/settings/managed-hosting')).json()).notice, null); assert.equal(hits.length, before); }
    finally { await missingToken.close(); }
    const redirect = createManagedNoticePoller({ managed: true, url: `${providerUrl}/redirect`, token: 'test-metrics-secret', log() {} });
    await redirect.start(); assert.equal(redirect.notice, null); redirect.stop();
    assert.equal(hits.some(hit => hit.url === '/must-not-receive-token'), false);
  } finally { await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }); }
});
