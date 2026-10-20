import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  await fixture.sql('UPDATE users SET demoNotesCreatedAt = ?', [new Date().toISOString()]);
  const { token } = await (await fetch(fixture.origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).json();
  const preferences = async patch => {
    const response = await fetch(fixture.origin + '/api/users/me/preferences', {
      method: patch ? 'PATCH' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: patch ? JSON.stringify(patch) : undefined
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  browser = await chromium.launch({ headless: true });
  const theme = async (page, expected) => {
    await page.waitForFunction(value =>
      document.body.classList.contains('light-theme') === (value === 'light') &&
      document.documentElement.style.colorScheme === value, expected);
  };
  const signIn = async page => {
    await page.goto(fixture.origin + '/', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('app-notes').waitFor();
  };
  const save = async (page, action) => {
    const response = page.waitForResponse(r => r.url().endsWith('/users/me/preferences') && r.request().method() === 'PATCH');
    await action();
    assert.equal((await response).status(), 200);
  };
  const foreground = (page, event) => page.evaluate(name => {
    if (name === 'focus') window.dispatchEvent(new Event('focus'));
    else if (name === 'visibilitychange') document.dispatchEvent(new Event('visibilitychange'));
    else window.emitAppEvent(name, { isActive: true });
  }, event);

  for (const platform of ['web', 'android', 'ios']) {
    await preferences({ followSystemTheme: true });
    // Native bridge contracts are emulated; this is not a physical-device test.
    const context = await browser.newContext({ colorScheme: 'dark', serviceWorkers: 'block',
      viewport: platform === 'web' ? { width: 1280, height: 900 } : { width: 390, height: 844 } });
    await context.addInitScript(name => {
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
      // Simulate an updated media preference without firing its change event.
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = query => {
        const media = matchMedia(query);
        if (query !== '(prefers-color-scheme: dark)') return media;
        return new Proxy(media, {
          get(target, key) {
            if (key === 'matches' && typeof window.silentSystemDark === 'boolean') return window.silentSystemDark;
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      };
      if (name !== 'web') {
        window.CapacitorCustomPlatform = { name };
        window.KEPT_API_URL = location.origin;
        const callbacks = new Map();
        let nextId = 0;
        window.emitAppEvent = (event, state = {}) => {
          for (const entry of callbacks.values()) if (entry.event === event) entry.callback(state);
        };
        window.Capacitor = {
          PluginHeaders: [{ name: 'App', methods: [
            { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }
          ] }],
          nativeCallback(plugin, method, options, callback) {
            const id = String(++nextId);
            callbacks.set(id, { event: options.eventName, callback });
            return id;
          },
          nativePromise(plugin, method, options) {
            if (method === 'removeListener') callbacks.delete(options.callbackId);
            return Promise.resolve({});
          }
        };
      }
    }, platform);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());
    await signIn(page);
    await theme(page, 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await theme(page, 'light');

    const events = platform === 'web' ? ['focus', 'visibilitychange'] : ['focus', 'visibilitychange', 'resume', 'appStateChange'];
    let appearance = 'light';
    for (const event of events) {
      const next = appearance === 'light' ? 'dark' : 'light';
      await page.evaluate(dark => { window.silentSystemDark = dark; }, next === 'dark');
      await theme(page, appearance); // No media-query event was delivered.
      await foreground(page, event);
      await theme(page, next);
      appearance = next;
    }
    await page.evaluate(() => { delete window.silentSystemDark; });
    await foreground(page, 'focus');
    await theme(page, 'light');

    await save(page, async () => {
      if (platform === 'web') await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
      else {
        await page.locator('app-navbar .menu-icon').click();
        await page.getByText('Use dark mode', { exact: true }).click();
      }
    });
    await theme(page, 'dark');
    assert.equal((await preferences()).followSystemTheme, false);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await theme(page, 'dark');
    await page.evaluate(() => { window.silentSystemDark = false; });
    for (const event of events) {
      await foreground(page, event);
      await theme(page, 'dark');
    }
    assert.equal((await preferences()).followSystemTheme, false, 'foreground events must preserve the manual override');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('app-notes').waitFor();
    await theme(page, 'dark');

    if (platform === 'web') {
      await page.goto(fixture.origin + '/settings', { waitUntil: 'domcontentloaded' });
      const automatic = page.getByRole('checkbox', { name: 'Follow system appearance', exact: true });
      await save(page, () => automatic.check());
      await theme(page, 'light');
      await page.emulateMedia({ colorScheme: 'dark' });
      await theme(page, 'dark');
      await save(page, () => automatic.uncheck());
      await page.emulateMedia({ colorScheme: 'light' });
      await theme(page, 'dark');
      assert.equal((await preferences()).theme, 'dark', 'disabling automatic mode retains the displayed theme');
    }
    console.log(`${platform}: live and missed system changes handled, foreground fallbacks work, manual override persists across foreground events and reload`);
    await context.close();
  }
  console.log('Settings: automatic mode can be re-enabled or disabled without unexpectedly switching appearance');
} finally {
  await browser?.close();
  await fixture.close();
}
