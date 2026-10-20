import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Uses an isolated server/database; native lifecycle
// callbacks are emulated here, not tested on a physical device.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  const api = async (path, token, body) => {
    const response = await fetch(fixture.origin + '/api' + path, {
      method: body ? (path.endsWith('/collaborators') || /\/notes\/\d+$/.test(path) ? 'PUT' : 'POST') : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.ok, true, `${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const owner = await api('/auth/login', null, credentials);
  const collaboratorCredentials = { username: 'collaborator', displayName: 'Collaborator', password: 'test-password-456' };
  const collaborator = await api('/users', owner.token, collaboratorCredentials);
  const collaboratorLogin = await api('/auth/login', null, collaboratorCredentials);
  await fixture.sql('UPDATE users SET demoNotesCreatedAt = ?', [new Date().toISOString()]);
  browser = await chromium.launch({ headless: true });
  const rows = () => fixture.sql('SELECT id, noteTitle, noteBody, checkBoxes FROM notes ORDER BY id');
  const saved = async (page, action, method = 'PUT') => {
    const response = page.waitForResponse(r => /\/api\/notes(?:\/\d+)?$/.test(r.url()) && r.request().method() === method);
    await action();
    assert.equal((await response).ok(), true);
  };
  for (const platform of ['web', 'android', 'ios']) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await context.addInitScript(name => {
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
      if (name === 'web') return;
      window.CapacitorCustomPlatform = { name };
      window.KEPT_API_URL = location.origin;
      const callbacks = new Map();
      let nextId = 0;
      window.emitAppEvent = (event, state = {}) => {
        for (const entry of callbacks.values()) if (entry.event === event) entry.callback(state);
      };
      window.appListenerCount = event => [...callbacks.values()].filter(entry => entry.event === event).length;
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
    }, platform);
    const page = await context.newPage();
    page.on('pageerror', error => console.error('Browser error:', error));
    page.setDefaultTimeout(10000);
    await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('app-notes').waitFor();
    const before = (await rows()).length;
    await page.locator('app-input .placeholder:visible input').click();
    const editor = page.locator('app-input .note-main:visible').first();
    const title = editor.getByRole('textbox', { name: 'Title', exact: true });
    const body = editor.locator('.note-body[contenteditable]');
    await saved(page, () => title.fill(`Autosave ${platform}`), 'POST');
    assert.equal(await editor.isVisible(), true, 'autosave must leave the composer open');
    assert.equal((await rows()).length, before + 1);
    const id = (await rows()).at(-1).id;
    await saved(page, () => body.fill('Typing pause'));

    // Trigger background immediately after typing, before the debounce expires.
    await saved(page, () => body.evaluate((el, name) => {
      el.innerHTML = 'Background flush';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (name === 'web') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      } else window.emitAppEvent('pause');
    }, platform));
    assert.equal((await rows()).at(-1).noteBody, 'Background flush');
    if (platform !== 'web') {
      await saved(page, () => body.evaluate(el => {
        el.innerHTML = 'App state flush';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        window.emitAppEvent('appStateChange', { isActive: false });
      }));
    }
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('app-input .placeholder:visible').waitFor();
    assert.equal((await rows()).length, before + 1, 'Close must update, not duplicate the new note');
    assert.equal((await rows()).at(-1).id, id);
    const listenerCounts = platform === 'web' ? null : await page.evaluate(() =>
      [window.appListenerCount('pause'), window.appListenerCount('appStateChange')]);

    await page.getByText(`Autosave ${platform}`, { exact: true }).click();
    const existing = page.locator('app-input .note-main:visible').last();
    await saved(page, () => existing.locator('.note-body[contenteditable]').fill('Personal note autosaved'));
    await existing.getByRole('button', { name: 'Close', exact: true }).click();
    await existing.waitFor({ state: 'hidden' });
    if (platform !== 'web') {
      await page.waitForFunction(counts => window.appListenerCount('pause') === counts[0] && window.appListenerCount('appStateChange') === counts[1], listenerCounts);
    }

    // A real second account edits through the API; the open editor receives
    // the update over its normal WebSocket/load path.
    await api(`/notes/${id}/collaborators`, owner.token, { userIds: [collaborator.id] });
    await page.getByText(`Autosave ${platform}`, { exact: true }).click();
    let writes = 0;
    const countWrites = request => {
      if (request.url().endsWith(`/api/notes/${id}`) && request.method() === 'PUT') writes++;
    };
    page.on('request', countWrites);
    await api(`/notes/${id}`, collaboratorLogin.token, { noteBody: '<b>Collaborator edit</b>' });
    await existing.locator('.note-body[contenteditable]').getByText('Collaborator edit', { exact: true }).waitFor();
    await page.evaluate(name => {
      if (name === 'web') window.dispatchEvent(new Event('pagehide'));
      else {
        window.emitAppEvent('pause');
        window.emitAppEvent('appStateChange', { isActive: false });
      }
    }, platform);
    await page.waitForTimeout(750); // Includes any already-pending 550ms debounce.
    assert.equal(writes, 0, 'backgrounding must not echo received collaborator content');
    await saved(page, () => existing.locator('.note-body[contenteditable]').fill('Local edit after collaborator')).catch(async error => {
      console.error('Shared editor after local edit:', await existing.locator('.note-body[contenteditable]').innerHTML(), 'writes:', writes);
      throw error;
    });
    assert.equal(writes, 1, 'a subsequent local edit must still save');
    await existing.getByRole('button', { name: 'Close', exact: true }).click();
    await existing.waitFor({ state: 'hidden' });
    assert.equal(writes, 1, 'closing an unchanged shared note must not write it back');
    page.off('request', countWrites);

    // Close while the initial create is still in flight. The final text must
    // land in the same note after creation completes.
    let releaseCreate;
    const heldCreate = new Promise(resolve => { releaseCreate = resolve; });
    await page.route('**/api/notes', async route => {
      if (route.request().method() === 'POST') await heldCreate;
      await route.continue();
    });
    await page.locator('app-input .placeholder:visible input').click();
    const createStarted = page.waitForRequest(r => r.url().endsWith('/api/notes') && r.method() === 'POST');
    await title.fill(`Race ${platform}`);
    await createStarted;
    await body.fill('Final edit while creating');
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    releaseCreate();
    await page.locator('app-input .placeholder:visible').waitFor();
    assert.equal((await rows()).length, before + 2);
    assert.equal((await rows()).at(-1).noteBody, 'Final edit while creating');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(`Race ${platform}`, { exact: true }).waitFor();
    console.log(`PASS ${platform}: new/personal autosave, background flush, stable ID, save/Close race, persistence, collaborator update without write-back, subsequent local edit${platform === 'web' ? '' : ', lifecycle listener cleanup'}`);
    await context.close();
  }
} finally {
  await browser?.close();
  await fixture.close();
}
