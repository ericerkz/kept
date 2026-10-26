const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('OIDC-only setup checks, password/session bypass prevention, login UI and recovery', async () => {
  const env = { KEPT_DISABLE_PASSWORD_LOGIN: '0', KEPT_OIDC_ISSUER: '', KEPT_OIDC_CLIENT_ID: '', KEPT_OIDC_NAME: 'Test Identity' };
  const fixture = await startFixture({ env });
  let token, browser;
  const credentials = { username: 'owner', displayName: 'Owner', password: 'isolated-oidc-password' };
  async function request(path, body, method = body ? 'POST' : 'GET', status = 200) {
    const response = await fetch(fixture.origin + '/api' + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, status, `${path}: ${await response.clone().text()}`);
    if (status === 204) return null;
    try { return await response.json(); } catch (error) { error.message = `${path}: ${error.message}`; throw error; }
  }
  try {
    const { user } = await request('/setup/admin', credentials, 'POST', 201);
    token = (await request('/auth/login', credentials)).token;
    assert.equal((await request('/auth/oidc/config')).passwordLoginEnabled, true);
    env.KEPT_DISABLE_PASSWORD_LOGIN = '1';
    await assert.rejects(fixture.restart(), /requires BASE_URL, KEPT_OIDC_ISSUER and KEPT_OIDC_CLIENT_ID/);
    env.KEPT_OIDC_ISSUER = 'https://identity.example'; env.KEPT_OIDC_CLIENT_ID = 'kept-test';
    await assert.rejects(fixture.restart(), /requires an enabled administrator linked/);
    const now = new Date().toISOString();
    await fixture.sql('INSERT INTO oidc_identities(issuer,subject,userId,createdAt,updatedAt) VALUES(?,?,?,?,?)', [env.KEPT_OIDC_ISSUER, 'owner-subject', user.id, now, now]);
    await fixture.sql('UPDATE users SET enabled = 0 WHERE id = ?', [user.id]);
    await assert.rejects(fixture.restart(), /requires an enabled administrator linked/);
    await fixture.sql("UPDATE users SET enabled = 1, role = 'user' WHERE id = ?", [user.id]);
    await assert.rejects(fixture.restart(), /requires an enabled administrator linked/);
    await fixture.sql("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
    env.KEPT_OIDC_ISSUER = 'not-an-issuer';
    await assert.rejects(fixture.restart(), /requires valid OIDC issuer and BASE_URL addresses/);
    env.KEPT_OIDC_ISSUER = 'https://different-issuer.example';
    await assert.rejects(fixture.restart(), /requires an enabled administrator linked/);
    env.KEPT_OIDC_ISSUER = 'https://identity.example';
    await fixture.restart(); // No live provider is required for startup or policy checks.
    assert.deepEqual(await request('/auth/oidc/config'), { enabled: true, name: 'Test Identity', passwordLoginEnabled: false });
    assert.ok((await request('/users')).some(account => account.id === user.id), 'existing authenticated sessions are retained');
    for (const path of ['/auth/login', '/auth/browser/login']) {
      for (const password of [credentials.password, 'wrong-password']) {
        const denied = await request(path, { ...credentials, password, totpToken: '123456' }, 'POST', 403);
        assert.equal(denied.code, 'PASSWORD_LOGIN_DISABLED');
      }
    }
    const link = await request('/auth/oidc/link/status');
    assert.equal(link.connected, true); assert.equal(link.passwordLoginEnabled, false);
    assert.equal((await request('/auth/oidc/link', undefined, 'DELETE', 409)).code, 'OIDC_REQUIRED');
    assert.equal((await request('/auth/oidc/link/status')).connected, true);
    await request('/settings/registration', { selfRegistrationEnabled: true, requireApproval: false }, 'PATCH');
    assert.equal((await request('/settings/registration')).selfRegistrationEnabled, true);
    assert.equal((await request('/settings/registration')).passwordLoginEnabled, false);
    assert.equal((await request('/auth/register', { username: 'new-user', email: 'new@example.test', password: credentials.password }, 'POST', 403)).code, 'PASSWORD_LOGIN_DISABLED');
    const invite = 'pending-invitation', digest = createHash('sha256').update(invite).digest('hex');
    await fixture.sql('INSERT INTO user_invites(email,role,tokenHash,invitedByUserId,createdAt,expiresAt) VALUES(?,?,?,?,?,?)',
      ['invited@example.test', 'user', digest, user.id, now, new Date(Date.now() + 86400000).toISOString()]);
    assert.equal((await request('/users/invite', { email: 'other@example.test' }, 'POST', 403)).code, 'PASSWORD_LOGIN_DISABLED');
    assert.equal((await request(`/invites/${invite}`, undefined, 'GET', 403)).code, 'PASSWORD_LOGIN_DISABLED');
    const accepted = { username: 'invited-user', displayName: 'Invited', password: credentials.password };
    assert.equal((await request(`/invites/${invite}/accept`, accepted, 'POST', 403)).code, 'PASSWORD_LOGIN_DISABLED');
    assert.equal((await fixture.sql('SELECT acceptedAt FROM user_invites WHERE tokenHash = ?', [digest]))[0].acceptedAt, null);
    assert.equal((await request('/users')).length, 1, 'blocked signup/invites do not create accounts');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    await page.goto(fixture.origin + '/login?oidc_error=no_account&oauth_request=pending-app');
    await page.getByRole('button', { name: 'Continue with Test Identity', exact: true }).waitFor();
    assert.equal(await page.locator('input[name="password"], input[name="username"], input[name="totpToken"], a[href="/register"]').count(), 0);
    await page.getByText('Your identity provider account is not linked to an enabled Kept user.', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/login', 'OIDC errors stay on a retryable page instead of redirecting');
    let failConfig = true;
    await page.route('**/api/auth/oidc/config', route => failConfig ? route.abort() : route.continue());
    await page.reload(); await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
    assert.equal(await page.locator('input[name="password"]').count(), 0, 'unknown policy does not expose a password form');
    failConfig = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Continue with Test Identity', exact: true }).waitFor();
    await browser.close(); browser = undefined;

    env.KEPT_DISABLE_PASSWORD_LOGIN = '0'; await fixture.restart();
    assert.equal((await request('/auth/login', credentials)).user.id, user.id, 'operator recovery restores password login');
    assert.equal((await request('/settings/registration')).selfRegistrationEnabled, true, 'underlying registration settings were retained');
    await request('/auth/oidc/link', undefined, 'DELETE', 204);
    assert.equal((await request(`/invites/${invite}/accept`, accepted, 'POST', 201)).user.username, accepted.username, 'paused invitations resume after recovery');
  } finally { await browser?.close(); await fixture.close(); }
});
