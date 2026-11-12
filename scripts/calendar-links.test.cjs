const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');

function harness(platform, apiUrl) {
  const copied = [];
  const document = { baseURI: platform === 'web' ? 'https://web.example.test/settings' : 'https://localhost/' };
  function load(path, extra = {}) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
    }).outputText, {
      exports, URL, document, navigator: { clipboard: { writeText: async value => copied.push(value) } }, setTimeout() {},
      require(name) {
    if (name.endsWith('/i18n/messages')) return require('../test-support/i18n.cjs');
        if (name === '@angular/core') return { Component: () => target => target };
        if (name === '@capacitor/core') return { Capacitor: { isNativePlatform: () => platform !== 'web' } };
        if (name.endsWith('/environment')) return { environment: { apiUrl } };
        if (name.endsWith('/server-links')) return extra;
        return {};
      }
    });
    return exports;
  }
  const links = load('src/app/utils/server-links.ts');
  const { SettingsComponent } = load('src/app/components/settings/settings.component.ts', links);
  const settings = Object.create(SettingsComponent.prototype);
  Object.assign(settings, {
    authService: { isLocal: false }, managedHosting: { info: async () => ({ managed: false }) },
    reminderService: {
      getGoogleCalendarStatus: async () => ({ hasCredentials: false, enabled: false }),
      getCalDavSettings: async () => null
    }
  });
  return { settings, links, copied };
}

for (const platform of ['ios', 'android', 'web']) {
  test(`${platform}: loading, regenerating and copying calendar links prefer the server URL and support older servers`, async () => {
    const api = platform === 'web' ? '/api' : 'https://notes.example.test/kept/api/';
    const base = platform === 'web' ? 'https://web.example.test/api' : 'https://notes.example.test/kept/api';
    const h = harness(platform, api);
    for (const provided of [false, true]) {
      const expected = token => provided ? `https://public.example.test/api/reminders/ics/${token}/kept-reminders.ics`
        : `${base}/reminders/ics/${token}/kept-reminders.ics`;
      const feed = token => ({ token, ...(provided ? { url: expected(token) } : {}) });
      h.settings.reminderService.getIcsFeedToken = async () => feed('original');
      h.settings.reminderService.regenerateIcsFeedToken = async () => feed('rotated');
      await h.settings.loadAll();
      assert.equal(h.settings.icsFeedUrl, expected('original'));
      await h.settings.copyFeedUrl(); assert.equal(h.copied.at(-1), expected('original'));
      await h.settings.regenerateFeedUrl();
      assert.equal(h.settings.icsFeedUrl, expected('rotated'));
      await h.settings.copyFeedUrl(); assert.equal(h.copied.at(-1), expected('rotated'));
      assert.equal(h.settings.icsFeedToken, 'rotated');
      assert.equal(h.settings.icsFeedError, '');
    }
    assert.equal(h.settings.googleRedirectUrl, `${base}/auth/google/callback`);
    h.settings.googleStatus.redirectUrl = 'https://public.example.test/api/auth/google/callback';
    assert.equal(h.settings.googleRedirectUrl, h.settings.googleStatus.redirectUrl);
  });
}

test('native fallback supports HTTP LAN servers and never substitutes the local app origin', () => {
  const h = harness('android', 'http://192.168.1.10:3000/api');
  assert.equal(h.links.serverApiUrl('/reminders/ics/test/kept-reminders.ics'), 'http://192.168.1.10:3000/api/reminders/ics/test/kept-reminders.ics');
  assert.throws(() => harness('ios', '/api').links.serverApiUrl('reminders/ics/test/kept-reminders.ics'), /Connect to your Kept server/);
});
