const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { startFixture } = require('../test-support/session-fixture.cjs');

async function setup() {
  const { startProvider, completeProviderRedirect } = await import('../test-support/oidc-provider.mjs');
  const provider = await startProvider();
  const env = { KEPT_DISABLE_PASSWORD_LOGIN: '0', KEPT_OIDC_ISSUER: provider.issuer, KEPT_OIDC_CLIENT_ID: 'kept-test', KEPT_OIDC_CLIENT_SECRET: 'test-secret' };
  let fixture, token;
  try {
    fixture = await startFixture({ env });
    async function api(path, body, method = body ? 'POST' : 'GET', status = 200) {
      const response = await fetch(fixture.origin + '/api' + path, { method, redirect: 'manual',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.status, status, await response.clone().text());
      return status === 204 ? null : response.json();
    }
    const credentials = { username: 'owner', displayName: 'Owner', password: 'isolated-oidc-password', email: 'owner@example.test' };
    const { user } = await api('/setup/admin', credentials, 'POST', 201);
    token = (await api('/auth/login', credentials)).token;
    provider.setIdentity({ sub: 'admin-subject', email: credentials.email, name: 'Owner' });
    const link = await api('/auth/oidc/link/start', {});
    assert.equal((await fetch(await completeProviderRedirect(link.url), { redirect: 'manual' })).status, 302);
    env.KEPT_DISABLE_PASSWORD_LOGIN = '1'; await fixture.restart();
    async function signIn(identity, native = false, oauthRequest = '') {
      provider.setIdentity(identity);
      const params = new URLSearchParams({ ...(native ? { return_url: 'kept://auth/oidc' } : {}), ...(oauthRequest ? { oauth_request: oauthRequest } : {}) });
      const start = await fetch(`${fixture.origin}/api/auth/oidc/start?${params}`, { redirect: 'manual' });
      assert.equal(start.status, 302);
      const callback = await completeProviderRedirect(start.headers.get('location'));
      const result = await fetch(callback, { redirect: 'manual' });
      assert.equal(result.status, 302);
      return new URL(result.headers.get('location'), fixture.origin);
    }
    async function submit(url, values, status, origin = fixture.origin) {
      const response = await fetch(url, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
      assert.equal(response.status, status, await response.clone().text());
      return response;
    }
    return { fixture, provider, api, user, token, signIn, submit, close: async () => { await fixture.close(); await provider.close(); } };
  } catch (error) { await fixture?.close(); await provider.close(); throw error; }
}

const account = { username: 'new-user', displayName: 'New User', email: 'new@example.test', password: 'new-account-password', confirmPassword: 'new-account-password' };

test('OIDC registration follows signup/approval policy and completes browser and native sign-in', async () => {
  const h = await setup();
  let browser;
  try {
    const identity = { sub: 'new-subject', email: account.email, name: account.displayName };
    const disabled = await h.signIn(identity);
    assert.equal(disabled.searchParams.get('oidc_error'), 'no_account');
    await h.api('/settings/registration', { selfRegistrationEnabled: true, requireApproval: true }, 'PATCH');
    const formUrl = await h.signIn(identity, false, 'pending-oauth');
    assert.match(formUrl.pathname, /^\/api\/auth\/oidc\/register\/kept_signup_/);
    const form = await fetch(formUrl);
    assert.match(form.headers.get('cache-control'), /no-store/);
    assert.equal(form.headers.get('referrer-policy'), 'same-origin');
    assert.match(await form.text(), /Create your Kept account/);
    await h.submit(formUrl, { ...account, confirmPassword: 'mismatch' }, 400);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(formUrl.href);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'account form fits a phone viewport');
    for (const [name, value] of Object.entries(account)) await page.locator(`input[name="${name}"]`).fill(value);
    const [submission] = await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && response.url() === formUrl.href), page.getByRole('button', { name: 'Create account', exact: true }).click()]);
    assert.equal(submission.status(), 302, `Form submission: ${await submission.text().catch(() => '')}`);
    await page.waitForURL('**/login?**');
    const target = new URL(page.url());
    assert.equal(target.searchParams.get('oidc_error'), 'pending_approval');
    await page.getByText('Your account was created. An administrator must approve it before you can sign in.', { exact: true }).waitFor();
    await browser.close(); browser = undefined;
    assert.equal(target.searchParams.get('oauth_request'), 'pending-oauth');
    assert.equal(target.searchParams.has('oidc_code'), false, 'unapproved accounts receive no login code');
    const newUser = (await h.api('/users')).find(user => user.username === account.username);
    assert.equal(newUser.role, 'user'); assert.equal(newUser.enabled, false);
    assert.equal((await h.signIn(identity)).searchParams.get('oidc_error'), 'account_unavailable');
    await h.submit(formUrl, account, 410);
    await h.api(`/users/${newUser.id}/toggle-enabled`, { enabled: true }, 'PATCH');
    const native = await h.signIn(identity, true, 'native-oauth');
    assert.equal(`${native.protocol}//${native.host}${native.pathname}`, 'kept://auth/oidc');
    assert.equal(native.searchParams.get('oauth_request'), 'native-oauth');
    const login = await h.api('/auth/oidc/exchange', { code: native.searchParams.get('oidc_code') });
    assert.equal(login.user.id, newUser.id); assert.equal(login.user.role, 'user');
    await h.api('/auth/oidc/exchange', { code: native.searchParams.get('oidc_code') }, 'POST', 400);
    const browserUrl = await h.signIn(identity);
    const anonymous = await fetch(h.fixture.origin + '/api/auth/browser/session');
    const csrf = (await anonymous.json()).csrfToken;
    const response = await fetch(h.fixture.origin + '/api/auth/browser/oidc/exchange', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: anonymous.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': csrf, Origin: h.fixture.origin },
      body: JSON.stringify({ code: browserUrl.searchParams.get('oidc_code') }) });
    assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    const session = await response.json(); assert.equal(session.user.id, newUser.id); assert.equal(session.token, undefined);
  } finally { await browser?.close(); await h.close(); }
});

test('native OIDC signup does not match email, overwrite users, elevate roles or expose provider markup', async () => {
  const h = await setup();
  try {
    await h.api('/settings/registration', { selfRegistrationEnabled: true, requireApproval: false }, 'PATCH');
    const identity = { sub: 'different-subject', email: 'owner@example.test', name: '<img src=x onerror=alert(1)>' };
    const url = await h.signIn(identity, true);
    const html = await (await fetch(url)).text();
    assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x/);
    assert.equal((await h.api('/users')).length, 1, 'verified email never links or creates an account by itself');
    await h.submit(url, { ...account, username: 'owner' }, 409);
    const created = await h.submit(url, { ...account, role: 'admin', enabled: 'true', userId: h.user.id }, 302);
    const target = new URL(created.headers.get('location'));
    assert.equal(`${target.protocol}//${target.host}${target.pathname}`, 'kept://auth/oidc');
    const login = await h.api('/auth/oidc/exchange', { code: target.searchParams.get('oidc_code') });
    assert.equal(login.user.username, account.username); assert.equal(login.user.role, 'user');
    assert.notEqual(login.user.id, h.user.id);
    assert.equal((await h.api('/users')).find(user => user.id === h.user.id).username, 'owner');
    assert.equal((await h.api('/auth/login', account, 'POST', 403)).code, 'PASSWORD_LOGIN_DISABLED');
  } finally { await h.close(); }
});

test('OIDC signup proofs expire, respect policy changes and can only create one linked account', async () => {
  const h = await setup();
  try {
    await h.api('/settings/registration', { selfRegistrationEnabled: true, requireApproval: false }, 'PATCH');
    const identity = { sub: 'one-use', email: account.email, name: 'New' };
    const first = await h.signIn(identity), second = await h.signIn(identity);
    await h.submit(first, account, 403, 'https://untrusted.example');
    await h.api('/settings/registration', { selfRegistrationEnabled: false }, 'PATCH');
    await h.submit(first, account, 410);
    await h.api('/settings/registration', { selfRegistrationEnabled: true }, 'PATCH');
    const firstToken = first.pathname.split('/').at(-1);
    await h.fixture.sql('UPDATE oidc_registrations SET expiresAt = ? WHERE tokenHash = ?', ['2000-01-01T00:00:00.000Z', createHash('sha256').update(firstToken).digest('hex')]);
    await h.submit(first, account, 410);
    const third = await h.signIn(identity);
    const results = await Promise.all([second, third].map((url, index) => fetch(url, { method: 'POST', redirect: 'manual',
      headers: { Origin: h.fixture.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...account, username: `concurrent-${index}` }) })));
    assert.deepEqual(results.map(response => response.status).sort(), [302, 409]);
    assert.equal((await h.api('/users')).length, 2);
    assert.equal((await h.fixture.sql('SELECT * FROM oidc_identities WHERE subject = ?', [identity.sub])).length, 1);
  } finally { await h.close(); }
});
