const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const webPush = require('web-push');
const { createIntegrationRequests, isPublicAddress } = require('./integration-requests');
const { startFixture } = require('../test-support/session-fixture.cjs');

function policy(options = {}) {
  return createIntegrationRequests({ caldavPrivateOrigins: '', pushPrivateOrigins: '', ...options });
}

function subscription(endpoint) {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return { endpoint, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('integration destinations reject private, mapped, local and reserved IPv4/IPv6 addresses', async () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    'fc00::1', 'fd00::1', 'fe80::1', 'fe90::1', 'febf::1', 'ff02::1', '64:ff9b::a00:1',
    '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1', 'not-an-ip'
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  const requests = policy({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  for (const url of ['http://localhost/calendar', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://[::ffff:7f00:1]/']) {
    await assert.rejects(requests.validateCaldavUrl(url), { code: 'OUTBOUND_TARGET_BLOCKED' });
  }
  for (const url of ['file:///etc/passwd', 'ftp://example.test/', 'https://user:password@example.test/', 'https://example.test/#fragment']) {
    await assert.rejects(requests.validateCaldavUrl(url), { code: 'OUTBOUND_TARGET_BLOCKED' });
  }
});

test('DNS is checked again at delivery and connections use the validated address without another lookup', async () => {
  let calls = 0;
  let address = '8.8.8.8';
  const requests = policy({ lookup: async () => { calls++; return [{ address, family: 4 }]; } });
  const value = subscription('https://push.example.test/delivery');
  await requests.validatePushSubscription(value);
  address = '127.0.0.1';
  let sent = false;
  await assert.rejects(requests.sendWebPush(value, 'test', { sendNotification() { sent = true; } }), { code: 'OUTBOUND_TARGET_BLOCKED' });
  assert.equal(sent, false, 'previously saved endpoints must be revalidated before delivery');
  address = '8.8.8.8';
  await requests.sendWebPush(value, 'payload', { async sendNotification(sub, payload, options) {
    assert.equal(sub.endpoint, value.endpoint);
    assert.equal(payload, 'payload');
    assert.equal(options.timeout, 8000);
    assert.ok(options.agent instanceof https.Agent);
    const before = calls;
    address = '127.0.0.1';
    const pinned = await new Promise((resolve, reject) => options.agent.options.lookup('push.example.test', { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses)));
    assert.deepEqual(pinned, [{ address: '8.8.8.8', family: 4 }]);
    assert.equal(calls, before, 'the socket must not resolve the hostname again');
  } });
  const mixed = policy({ lookup: async () => [{ address: '127.0.0.1', family: 4 }, { address: '1.1.1.1', family: 4 }] });
  await mixed.sendWebPush(value, 'test', { async sendNotification(_sub, _payload, options) {
    await new Promise((resolve, reject) => options.agent.options.lookup('push.example.test', {}, (error, ip) => {
      if (error) return reject(error);
      assert.equal(ip, '1.1.1.1'); resolve();
    }));
  } });
});

test('private exceptions match exact configured origins and do not cross integration boundaries', async () => {
  const requests = policy({
    caldavPrivateOrigins: 'http://calendar.internal:5232',
    pushPrivateOrigins: 'https://push.internal:8443',
    lookup: async () => [{ address: '10.0.0.2', family: 4 }]
  });
  assert.equal(await requests.validateCaldavUrl('http://calendar.internal:5232/users/calendar/'), 'http://calendar.internal:5232/users/calendar/');
  await requests.validatePushSubscription(subscription('https://push.internal:8443/delivery'));
  for (const url of ['http://calendar.internal:5233/', 'https://calendar.internal:5232/', 'http://calendar.internal.evil:5232/', 'https://push.internal:8443/']) {
    await assert.rejects(requests.validateCaldavUrl(url), { code: 'OUTBOUND_TARGET_BLOCKED' });
  }
  for (const url of ['https://calendar.internal:5232/push', 'https://push.internal:8444/push', 'http://push.internal:8443/push']) {
    await assert.rejects(requests.validatePushSubscription(subscription(url)), { code: 'OUTBOUND_TARGET_BLOCKED' });
  }
  for (const origin of ['*', 'http://calendar.internal/path', 'http://user:password@calendar.internal', 'http://calendar.internal/?query=1']) {
    assert.throws(() => policy({ caldavPrivateOrigins: origin }));
  }
});

test('allowed CalDAV preserves HTTP, credentials, query strings, PROPFIND/PUT/DELETE and does not follow redirects', async t => {
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push({ method: request.method, path: request.url, auth: request.headers.authorization, body });
      response.writeHead(request.url === '/redirect' ? 302 : 207, { Location: '/should-not-be-followed' }); response.end();
    });
  });
  const port = await listen(t, server);
  const origin = `http://127.0.0.1:${port}`;
  const requests = policy({ caldavPrivateOrigins: origin });
  const settings = { calendarUrl: `${origin}/calendar/?token=test`, username: 'user', password: 'password' };
  await requests.caldavRequest(settings, null, 'PROPFIND', null);
  await requests.caldavRequest(settings, 9, 'PUT', 'BEGIN:VCALENDAR');
  await requests.caldavRequest(settings, 9, 'DELETE', null);
  assert.deepEqual(received.map(row => [row.method, row.path]), [
    ['PROPFIND', '/calendar/?token=test'], ['PUT', '/calendar/kept-reminder-9.ics?token=test'], ['DELETE', '/calendar/kept-reminder-9.ics?token=test']
  ]);
  assert.equal(received[1].body, 'BEGIN:VCALENDAR');
  assert.ok(received.every(row => row.auth === `Basic ${Buffer.from('user:password').toString('base64')}`));
  await assert.rejects(requests.caldavRequest({ ...settings, calendarUrl: `${origin}/redirect` }, null, 'PROPFIND', null), /redirected/);
  assert.equal(received.length, 4);
  await assert.rejects(policy().caldavRequest(settings, 10, 'PUT', 'private'), { code: 'OUTBOUND_TARGET_BLOCKED' });
  assert.equal(received.length, 4);
});

test('real web-push delivery preserves hostname routing, SNI and TLS verification through a pinned agent', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kept-push-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'openssl.cnf');
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=push.example.test\n[extensions]\nsubjectAltName=DNS:push.example.test\nbasicConstraints=CA:TRUE\n');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('OpenSSL is needed to generate the local test certificate.');
    throw error;
  }
  const cert = await readFile(certFile);
  const received = [];
  const server = https.createServer({ key: await readFile(keyFile), cert }, (request, response) => {
    received.push({ host: request.headers.host, sni: request.socket.servername, method: request.method });
    request.resume(); response.writeHead(201); response.end();
  });
  const port = await listen(t, server);
  const origin = `https://push.example.test:${port}`;
  const requests = policy({ pushPrivateOrigins: origin, lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  const keys = webPush.generateVAPIDKeys();
  webPush.setVapidDetails('https://example.test', keys.publicKey, keys.privateKey);
  const sender = { sendNotification(value, payload, options) {
    // Trust only this test certificate; certificate/hostname checks stay on.
    options.agent.options.ca = cert;
    return webPush.sendNotification(value, payload, options);
  } };
  const result = await requests.sendWebPush(subscription(`${origin}/delivery`), 'reminder', sender);
  assert.equal(result.statusCode, 201);
  assert.deepEqual(received, [{ host: `push.example.test:${port}`, sni: 'push.example.test', method: 'POST' }]);
  const wrongHostname = policy({ pushPrivateOrigins: `https://wrong.example.test:${port}`, lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(wrongHostname.sendWebPush(subscription(`https://wrong.example.test:${port}/delivery`), 'reminder', sender), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.equal(received.length, 1);
});

test('HTTP-hosted Kept accepts public push endpoints, blocks internal probes and supports configured private CalDAV', async t => {
  const received = [];
  const calendarServer = http.createServer((request, response) => {
    received.push(request.method); request.resume(); response.writeHead(207); response.end();
  });
  const port = await listen(t, calendarServer);
  const calendarOrigin = `http://127.0.0.1:${port}`;
  const env = { KEPT_CALDAV_ALLOWED_PRIVATE_ORIGINS: '', KEPT_PUSH_ALLOWED_PRIVATE_ORIGINS: '' };
  const fixture = await startFixture({ env }); t.after(() => fixture.close());
  let token;
  async function request(route, body, status = 200, method = 'POST') {
    const response = await fetch(fixture.origin + '/api' + route, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    return payload;
  }
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  await request('/setup/admin', credentials, 201);
  token = (await request('/auth/login', credentials)).token;
  await request('/users', { username: 'user', displayName: 'User', password: credentials.password }, 201);
  token = (await request('/auth/login', { username: 'user', password: credentials.password })).token;
  const settings = { calendarUrl: `${calendarOrigin}/calendar/`, username: 'user', password: 'password', enabled: true };
  const denied = await request('/caldav/test', settings);
  assert.equal(denied.ok, false); assert.match(denied.error, /administrator approval/);
  await request('/caldav/settings', settings, 400, 'PUT');
  assert.deepEqual(await fixture.sql('SELECT * FROM caldav_settings'), []);
  await request('/caldav/settings', { ...settings, enabled: false }, 200, 'PUT');
  await request('/caldav/settings', settings, 400, 'PUT');
  assert.equal((await fixture.sql('SELECT enabled FROM caldav_settings'))[0].enabled, 0);
  for (const endpoint of [`https://127.0.0.1:${port}/push`, 'https://[::1]/push', 'http://8.8.8.8/push']) {
    await request('/push/subscriptions', { subscription: subscription(endpoint) }, 400);
  }
  await request('/push/subscriptions', { subscription: { endpoint: 'https://8.8.8.8/push', keys: { p256dh: 'bad', auth: 'bad' } } }, 400);
  assert.match(fixture.origin, /^http:/);
  await request('/push/subscriptions', { subscription: subscription('https://8.8.8.8/push') }, 201);
  assert.equal((await fixture.sql('SELECT endpoint FROM push_subscriptions'))[0].endpoint, 'https://8.8.8.8/push');
  // Older saved CalDAV settings must also be blocked at the time of sending.
  await fixture.sql(`INSERT OR REPLACE INTO caldav_settings (userId, serverUrl, calendarUrl, username, password, enabled, createdAt, updatedAt)
    SELECT id, ?, ?, 'user', 'password', 1, '2026-01-01', '2026-01-01' FROM users WHERE username = 'user'`, [calendarOrigin, settings.calendarUrl]);
  await request('/reminders', { title: 'Future reminder', dueAtUtc: '2099-01-01T00:00:00Z' }, 201);
  assert.deepEqual(received, []);
  env.KEPT_CALDAV_ALLOWED_PRIVATE_ORIGINS = calendarOrigin;
  env.KEPT_PUSH_ALLOWED_PRIVATE_ORIGINS = `https://127.0.0.1:${port}`;
  await fixture.restart();
  assert.equal((await request('/caldav/test', settings)).httpStatus, 207);
  assert.equal((await request('/caldav/test', { ...settings, calendarUrl: `http://127.0.0.1:${port + 1}/` })).ok, false);
  await request('/push/subscriptions', { subscription: subscription(`https://127.0.0.1:${port}/push`) }, 201);
  assert.deepEqual(received, ['PROPFIND']);
});
