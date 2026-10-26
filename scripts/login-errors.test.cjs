const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const rx = require('rxjs');

function load(file) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText;
  vm.runInNewContext(source, { exports, console, require(name) {
    if (name === '@angular/core') return { Injectable: () => target => target, Component: () => target => target };
    if (name === '@angular/common/http') return {};
    if (name === '@capacitor/core') return {};
    if (name === 'rxjs') return rx;
    if (name.endsWith('/environment')) return { environment: { apiUrl: '/api' } };
    if (name.endsWith('/note-html')) return {};
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  return exports;
}

const { AuthService } = load('src/app/services/auth.service.ts');
const { LoginComponent } = load('src/app/components/auth/login/login.component.ts');

function harness({ error, browser = false } = {}) {
  const requests = [], stored = [], navigations = [];
  const auth = Object.create(AuthService.prototype);
  const result = browser ? { user: { id: 1 }, csrfToken: 'csrf' } : { user: { id: 1 }, token: 'native-token' };
  Object.assign(auth, {
    apiUrl: '/api', usesBrowserSession: browser,
    authHeaders: () => ({}), refreshBrowserSession: async () => requests.push('browser-session'),
    storeLoginResult: value => stored.push(value),
    http: { post(url, body) {
      requests.push({ url, body });
      return error ? rx.throwError(() => error) : rx.of(result);
    } }
  });
  const component = new LoginComponent(auth, { navigateByUrl: url => navigations.push(url) }, {});
  component.username = 'owner'; component.password = 'password';
  return { auth, component, requests, stored, navigations };
}

test('only the actual Kept username/password rejection becomes the credentials error', async () => {
  const h = harness({ error: { status: 401, error: { error: 'Username or password is incorrect.' } } });
  assert.equal(await h.auth.login('owner', 'wrong'), false);
  await h.component.submit();
  assert.equal(h.component.error, 'Username or password is incorrect.');
  assert.equal(h.component.isSigningIn, false);
  assert.equal(h.stored.length, 0);
  assert.equal(h.navigations.length, 0);
  const proxy = harness({ error: { status: 401, error: '<html>Proxy authentication required</html>' } });
  await proxy.component.submit();
  assert.equal(proxy.component.error, 'Could not sign in.');
});

test('network, timeout and server failures get useful messages and never store a session or navigate', async () => {
  const cases = [
    [{ status: 0 }, /Could not connect to your server/],
    [{ name: 'TimeoutError' }, /timed out/],
    [{ status: 408 }, /timed out/],
    ...[500, 502, 503, 504].map(status => [{ status, error: { error: 'Internal upstream details' } }, /server is temporarily unavailable/])
  ];
  for (const [error, expected] of cases) {
    const h = harness({ error });
    await assert.rejects(h.auth.login('owner', 'password'), value => value === error);
    await h.component.submit();
    assert.match(h.component.error, expected);
    assert.doesNotMatch(h.component.error, /password is incorrect|Internal upstream details/);
    assert.equal(h.component.isSigningIn, false);
    assert.equal(h.stored.length, 0);
    assert.equal(h.navigations.length, 0);
  }
});

test('2FA prompts, invalid codes, pending approval and rate-limit messages stay distinguishable', async () => {
  const required = harness({ error: { status: 401, error: { requires2FA: true } } });
  await required.component.submit();
  assert.equal(required.component.requires2FA, true);
  assert.equal(required.component.error, '');
  for (const [status, message] of [
    [401, 'Invalid 2FA code or backup code.'],
    [403, 'Your account is pending approval by an administrator.'],
    [429, 'Too many invalid 2FA attempts. Try again in 15 minutes.']
  ]) {
    const h = harness({ error: { status, error: { error: message } } });
    h.component.requires2FA = true; h.component.totpToken = '123456';
    await h.component.submit();
    assert.equal(h.component.error, message);
    assert.equal(h.requests[0].body.totpToken, '123456');
    assert.equal(h.component.isSigningIn, false);
  }
  const limited = harness({ error: { status: 429 } });
  await limited.component.submit();
  assert.match(limited.component.error, /Too many sign-in attempts/);
});

test('successful native and browser login still use their original endpoints and session handling', async () => {
  for (const browser of [false, true]) {
    const h = harness({ browser });
    await h.component.submit();
    assert.equal(h.component.error, '');
    assert.equal(h.component.isSigningIn, false);
    assert.equal(h.requests.at(-1).url, browser ? '/api/auth/browser/login' : '/api/auth/login');
    assert.equal(h.requests.includes('browser-session'), browser);
    assert.equal(h.stored.length, 1);
    assert.deepEqual(h.navigations, ['/']);
  }
});

test('login options honor OIDC-only policy, keep older servers compatible and recover from config failures', async () => {
  for (const config of [
    { enabled: false, name: 'SSO' },
    { enabled: true, name: 'SSO', passwordLoginEnabled: true },
    { enabled: true, name: 'SSO', passwordLoginEnabled: false }
  ]) {
    const h = harness(); h.auth.getOidcConfig = async () => config;
    await h.component.loadSignInOptions();
    assert.equal(h.component.passwordLoginEnabled, config.passwordLoginEnabled !== false);
    assert.equal(h.component.loadingSignInOptions, false);
    if (config.passwordLoginEnabled === false) {
      await h.component.submit(); assert.equal(h.requests.length, 0);
      assert.equal(h.component.password, '');
    }
  }
  const h = harness(); h.auth.getOidcConfig = async () => { throw { status: 0 }; };
  await h.component.loadSignInOptions(); assert.equal(h.component.signInOptionsUnavailable, true);
  await h.component.submit(); assert.equal(h.requests.length, 0);
  h.auth.getOidcConfig = async () => ({ enabled: true, name: 'SSO', passwordLoginEnabled: false });
  await h.component.loadSignInOptions(); assert.equal(h.component.signInOptionsUnavailable, false);
  const changed = harness({ error: { status: 403, error: { code: 'PASSWORD_LOGIN_DISABLED', error: 'Use SSO.' } } });
  await changed.component.submit(); assert.equal(changed.component.passwordLoginEnabled, false);
  assert.equal(changed.component.error, 'Use SSO.');
});
