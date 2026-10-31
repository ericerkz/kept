const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

for (const configuredBase of ['', 'https://notes.example.test///']) {
  test(`calendar links use ${configuredBase ? 'BASE_URL with trailing slashes removed' : 'the request URL without BASE_URL'}`, async () => {
    const fixture = await startFixture({ env: { BASE_URL: configuredBase } });
    const publicBase = configuredBase.replace(/\/+$/, '') || fixture.origin;
    let token;
    async function api(path, method = 'GET', body, status = 200) {
      const response = await fetch(`${fixture.origin}/api${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      assert.equal(response.status, status, await response.clone().text());
      return response.json();
    }
    try {
      const credentials = { username: 'calendar-owner', displayName: 'Calendar owner', password: 'test-password-123' };
      await api('/setup/admin', 'POST', credentials, 201);
      token = (await api('/auth/login', 'POST', credentials)).token;
      await api('/reminders', 'POST', { title: 'Calendar subscription test', dueAtUtc: '2030-01-01T12:00:00.000Z', timezone: 'UTC' }, 201);
      const feed = await api('/reminders/ics-token');
      assert.equal(feed.url, `${publicBase}/api/reminders/ics/${feed.token}/kept-reminders.ics`);
      assert.deepEqual(await api('/reminders/ics-token'), feed, 'reading the link does not rotate its secret');
      const subscription = await fetch(fixture.origin + new URL(feed.url).pathname);
      assert.equal(subscription.status, 200);
      assert.match(subscription.headers.get('content-type'), /text\/calendar/);
      const calendar = await subscription.text();
      assert.match(calendar, /BEGIN:VCALENDAR/);
      assert.match(calendar, /SUMMARY:Calendar subscription test/);
      const rotated = await api('/reminders/ics-token', 'POST', {});
      assert.notEqual(rotated.token, feed.token);
      assert.equal(rotated.url, `${publicBase}/api/reminders/ics/${rotated.token}/kept-reminders.ics`);
      assert.equal((await fetch(fixture.origin + new URL(feed.url).pathname)).status, 404);
      assert.equal((await fetch(fixture.origin + new URL(rotated.url).pathname)).status, 200);
      assert.equal((await fetch(`${fixture.origin}/api/reminders/ics/${rotated.token}`)).status, 200, 'legacy subscriptions still work');
      const google = await api('/google-calendar/status');
      assert.equal(google.redirectUrl, `${publicBase}/api/auth/google/callback`);
      await api('/google-calendar/credentials', 'PUT', { clientId: 'test-client', clientSecret: 'test-secret', enabled: false });
      const authorization = await api('/auth/google/initiate', 'POST', {});
      assert.equal(new URL(authorization.url).searchParams.get('redirect_uri'), google.redirectUrl);
    } finally { await fixture.close(); }
  });
}
