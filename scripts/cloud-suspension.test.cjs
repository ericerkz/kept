const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), rx = require('rxjs');
const settle = () => new Promise(resolve => setImmediate(resolve));

class HttpErrorResponse extends Error {
  constructor(input) { super(`HTTP ${input.status}`); Object.assign(this, input); }
}

function harness(platform = 'android', available = true) {
  const clock = { now: 0 }, calls = [], warnings = [];
  let open = async () => {};
  function load(file) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
    }).outputText, {
      exports, URL, Blob, Promise, Date: { now: () => clock.now },
      console: { warn: (...args) => warnings.push(args) },
      window: { location: { origin: platform === 'web' ? 'https://server.test' : 'https://localhost' } },
      require(name) {
        if (name === '@angular/core') return { Injectable: () => target => target };
        if (name === '@angular/common/http') return { HttpErrorResponse };
        if (name === '@capacitor/core') return {
          Capacitor: { getPlatform: () => platform, isPluginAvailable: () => available },
          registerPlugin: name => ({ start: async () => { calls.push(name); await open(); } })
        };
        if (name === 'rxjs') return rx;
        if (name.endsWith('/environment')) return { environment: { apiUrl: 'https://server.test/api' } };
        if (name.endsWith('/note-html')) return {};
        throw new Error(`Unexpected dependency: ${name}`);
      }
    });
    return exports;
  }
  const { AuthService } = load('src/app/services/auth.service.ts');
  const auth = Object.create(AuthService.prototype);
  Object.assign(auth, {
    workspace: { isLocal: false }, currentUser$: new rx.BehaviorSubject(null),
    cloudSuspensionNotice$: new rx.BehaviorSubject(null), zone: { run: fn => fn() },
    lastCloudSuspendedNoticeAt: -Infinity, cloudSuspensionScreenOpen: false, usesBrowserSession: platform === 'web'
  });
  const { AuthExpiredInterceptor } = load('src/app/services/auth-expired.interceptor.ts');
  const interceptor = new AuthExpiredInterceptor(auth);
  async function send(body = { code: 'CLOUD_SUSPENDED', accountUrl: 'https://account.test/billing' }, { status = 402, url = 'https://server.test/api/notes' } = {}) {
    const error = new HttpErrorResponse({ status, error: body });
    const request = { url, method: 'GET', headers: { has: () => false }, clone() { return this; } };
    await assert.rejects(rx.firstValueFrom(interceptor.intercept(request, { handle: () => rx.throwError(() => error) })), actual => actual === error);
    await settle();
  }
  return { auth, calls, clock, warnings, send, setOpen: callback => open = callback };
}

test('Android catches suspension across API routes and opens at most once per 30 seconds', async () => {
  const h = harness();
  await Promise.all(['/api/auth/oidc/config', '/api/notes', '/api/sync/changes', '/api/settings/storage'].map(path =>
    h.send(undefined, { url: `https://server.test${path}` })));
  assert.deepEqual(h.calls, ['KeptManagedHosting']);
  assert.equal(h.auth.cloudSuspensionNotice$.value, null);
  h.clock.now = 29999; await h.send(); assert.equal(h.calls.length, 1);
  h.clock.now = 30000; await h.send(); assert.equal(h.calls.length, 2);
});

test('Android does not open another screen while the first remains open, and a rejected open stays throttled', async () => {
  const h = harness(); let close;
  h.setOpen(() => new Promise(resolve => close = resolve));
  await h.send(); h.clock.now = 60000; await h.send(); assert.equal(h.calls.length, 1);
  close(); await settle();
  h.setOpen(async () => { throw new Error('Native screen unavailable'); });
  await h.send(); assert.equal(h.calls.length, 2); assert.equal(h.warnings.length, 1);
  await h.send(); assert.equal(h.calls.length, 2);
});

test('iOS leaves presentation entirely to native code; older Android builds do not attempt a missing plugin', async () => {
  for (const h of [harness('ios'), harness('ios', false), harness('android', false)]) {
    await h.send(); assert.deepEqual(h.calls, []); assert.equal(h.auth.cloudSuspensionNotice$.value, null);
  }
});

test('browser notices use the response account URL, are dismissible and do not use native presentation', async () => {
  const h = harness('web');
  await h.send();
  assert.equal(h.auth.cloudSuspensionNotice$.value.accountUrl, 'https://account.test/billing');
  assert.deepEqual(h.calls, []);
  h.auth.dismissCloudSuspensionNotice(); assert.equal(h.auth.cloudSuspensionNotice$.value, null);
  await h.send(); assert.equal(h.auth.cloudSuspensionNotice$.value, null, 'a burst must not immediately undo dismissal');
  h.clock.now = 30000; await h.send(); assert.ok(h.auth.cloudSuspensionNotice$.value);
});

test('suspension is recognized for JSON, text and blob responses without swallowing the original HTTP error', async () => {
  const payload = JSON.stringify({ code: 'CLOUD_SUSPENDED', accountUrl: 'https://account.test/paused' });
  for (const body of [JSON.parse(payload), payload, new Blob([payload], { type: 'application/json' })]) {
    const h = harness('web'); await h.send(body);
    assert.equal(h.auth.cloudSuspensionNotice$.value.accountUrl, 'https://account.test/paused');
  }
});

test('ordinary 402s, malformed bodies, other statuses and third-party requests do not trigger suspension UI', async () => {
  const h = harness();
  await h.send({ code: 'UNRELATED' });
  await h.send('<html>Payment required</html>');
  await h.send(new Blob(['invalid JSON']));
  await h.send(undefined, { status: 503 });
  await h.send(undefined, { url: 'https://unrelated.test/api/notes' });
  assert.deepEqual(h.calls, []);
});

test('browser notices reject executable or credential-bearing account URLs', async () => {
  for (const accountUrl of [undefined, 'javascript:alert(1)', 'data:text/html,unsafe', 'https://user:password@account.test/']) {
    const h = harness('web'); await h.send({ code: 'CLOUD_SUSPENDED', accountUrl });
    assert.equal(h.auth.cloudSuspensionNotice$.value.accountUrl, null);
  }
});
