import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
try {
  browser = await (process.env.KEPT_TEST_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  const setup = await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  assert.equal(setup.status, 201);

  async function until(check, message) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(message);
  }

  const cases = JSON.parse(await readFile(new URL('../test-support/note-html-cases.json', import.meta.url), 'utf8'));
  const owner = await (await fetch(fixture.origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) })).json();
  const attackerUser = await (await fetch(fixture.origin + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner.token }, body: JSON.stringify({ username: 'attacker', displayName: 'Attacker', password: credentials.password, role: 'user' }) })).json();
  assert.equal(attackerUser.role, 'user');
  const attacker = await (await fetch(fixture.origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'attacker', password: credentials.password }) })).json();
  const shared = await (await fetch(fixture.origin + '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + attacker.token }, body: JSON.stringify({ noteTitle: 'Shared regression', noteBody: '<b>Shared formatting</b>' }) })).json();
  assert.ok(shared.id);
  await fetch(fixture.origin + '/api/notes/' + shared.id + '/collaborators', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + attacker.token }, body: JSON.stringify({ userIds: [owner.user.id] }) });

  for (const platform of ['web', 'ios', 'android']) {
    const context = await browser.newContext({ viewport: platform === 'web' ? { width: 1440, height: 900 } : { width: 390, height: 844 } });
    await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
    if (platform !== 'web') {
      // Exercise Capacitor's actual platform detection and shared production
      // bundle. This is contract emulation, not a physical-device test.
      await context.addInitScript(name => {
        window.CapacitorCustomPlatform = { name };
        window.KEPT_API_URL = location.origin.replace('localhost', '127.0.0.1');
        window.Capacitor = { Plugins: { KeptConnectionHeaders: {
          getEnabledHeaders: async () => ({ headers: [{ name: 'X-Kept-Test-Gateway', value: 'native-contract' }] })
        } } };
      }, platform);
    }
    const pageOrigin = platform === 'web' ? fixture.origin : fixture.origin.replace('127.0.0.1', 'localhost');
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const apiFailures = [];
    page.on('response', response => {
      if (response.url().includes('/api/') && [401, 403].includes(response.status())) apiFailures.push(response.url());
    });
    const wsUrls = [];
    const noteRequests = [];
    page.on('request', req => { if (new URL(req.url()).pathname === '/api/notes') noteRequests.push(req.headers()); });
    page.on('websocket', socket => wsUrls.push(socket.url()));
    try {
      await page.goto(pageOrigin + '/login');
      await page.getByLabel('Username', { exact: true }).fill(credentials.username);
      await page.getByLabel('Password', { exact: true }).fill(credentials.password);
      const responsePromise = page.waitForResponse(r => /\/auth\/(?:browser\/)?login$/.test(r.url()));
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const login = await (await responsePromise).json();
      await page.waitForURL(pageOrigin + '/');
      await page.locator('app-notes').waitFor();
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gk_session')));
      const usesCookie = !login.token;
      assert.equal(!!stored.token, !usesCookie);
      if (platform !== 'web') assert.equal(usesCookie, false, 'native bearer contract must be preserved');
      const documentResponse = await context.request.get(pageOrigin + '/');
      assert.match(documentResponse.headers()['content-security-policy'], /script-src-attr 'none'/);
      const api = async (route, options = {}) => {
        const headers = usesCookie
          ? { 'X-CSRF-Token': (await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json()).csrfToken }
          : { Authorization: `Bearer ${stored.token}` };
        return context.request.fetch(fixture.origin + '/api' + route, { ...options, headers });
      };
      await until(() => wsUrls.some(url => url.includes('/api/realtime')), 'realtime connection did not start');

      const openComposer = async () => {
        if (await page.getByPlaceholder('Take a note…').first().isVisible()) await page.getByPlaceholder('Take a note…').first().click();
        else await page.getByRole('button', { name: 'New note', exact: true }).click();
      };
      const closeComposer = async () => {
        const close = page.locator('.note-main:visible .close-btn').first();
        if (await close.isVisible()) await close.click();
        else await page.locator('.mobile-icon.back:visible').first().click();
      };
      // Create through the real editor and offline mutation pipeline.
      const title = `${platform} session regression note`;
      await openComposer();
      await page.locator('.note-title[contenteditable]:visible').first().fill(title);
      await page.locator('.note-body[contenteditable]:visible').first().fill('Rich note survives cookie authentication');
      await closeComposer();
      const notes = async () => (await api('/notes')).json();
      await until(async () => (await notes()).some(note => note.noteTitle === title), 'editor note was not synced');
      await page.reload();
      await page.getByText(title, { exact: true }).first().waitFor();

      // Save an actual canvas drawing through the editor, then reload it.
      const beforeDrawing = await notes();
      const drawingBefore = beforeDrawing.length;
      const previousIds = new Set(beforeDrawing.map(note => note.id));
      if (await page.locator('[data-pop="New note with drawing"]').first().isVisible()) {
        await page.locator('[data-pop="New note with drawing"]').first().click();
      } else {
        await openComposer();
        await page.locator('.mobile-new-note-starters button').filter({ hasText: 'Drawing' }).click();
      }
      const canvas = page.locator('canvas:visible').first();
      await canvas.waitFor();
      const bounds = await canvas.boundingBox();
      assert.ok(bounds && bounds.width > 0);
      await page.mouse.move(bounds.x + 80, bounds.y + 80);
      await page.mouse.down();
      await page.mouse.move(bounds.x + 160, bounds.y + 140, { steps: 10 });
      await page.mouse.up();
      await page.getByRole('button', { name: 'Back', exact: true }).first().click();
      await until(async () => (await notes()).length > drawingBefore, 'drawing was not saved');
      const drawing = (await notes()).find(note => !previousIds.has(note.id) && note.images?.some(image => image.id === 'drawing' && image.dataUrl));
      assert.ok(drawing, 'canvas drawing data must be retained');

      // Protected image requests are made by the browser image loader itself.
      const image = await (await api('/uploads/images', {
        method: 'POST', multipart: { image: { name: 'pixel.png', mimeType: 'image/png',
          buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64') } }
      })).json();
      const imageResponse = await api(image.url.replace(/^\/api/, ''));
      assert.equal(imageResponse.status(), 200);
      const backup = await (await api('/admin/backup/now', { method: 'POST', data: {} })).json();
      assert.equal((await api('/admin/backup/download/' + backup.filename)).status(), 200);

      await page.locator(`[data-note-id]`).filter({ hasText: title }).first().locator('.title').click();
      const richBody = `<h1>Rich heading</h1><div><b>Bold</b> <i>Italic</i> <u>Underline</u></div><ul><li>List item</li></ul><a href="https://example.test">Preview link</a>`;
      await page.locator('.note-body[contenteditable]:visible').first().evaluate((element, html) => {
        element.innerHTML = html;
        element.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }, richBody);
      await page.locator('app-input').filter({ has: page.locator('.note-body[contenteditable]:visible') }).locator('input.image-input').setInputFiles({
        name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64')
      });
      await page.locator('.note-body[contenteditable]:visible img.inline-note-image').waitFor();
      await closeComposer();
      await until(async () => (await notes()).find(note => note.noteTitle === title)?.noteBody?.includes('Rich heading'), 'rich editor note did not sync');
      const savedRich = (await notes()).find(note => note.noteTitle === title);
      for (const tag of ['h1', 'b', 'i', 'u', 'ul', 'li', 'a', 'img']) assert.ok(savedRich.noteBody.includes('<' + tag), 'rich content retained: ' + tag);
      assert.ok(!savedRich.noteBody.includes('inline-image-delete-btn'), 'editor controls must not become note content');
      assert.ok(!savedRich.noteBody.includes('>close<'), 'editor control text must not leak into saved notes');
      await page.reload();
      await page.locator(`[data-note-id="${savedRich.id}"] .title`).click();
      await page.locator('.note-body:visible img.inline-note-image').waitFor();
      assert.ok(await page.locator('.note-body:visible .inline-image-delete-btn').count());
      await closeComposer();

      if (usesCookie) {
        // Simulate an unavailable session bootstrap after a reload. Retain the
        // offline account partition, then obtain CSRF again when writes resume.
        await page.route('**/api/auth/browser/session', route => route.abort());
        await page.reload();
        await page.getByText(title, { exact: true }).first().waitFor();
        await page.unroute('**/api/auth/browser/session');
      }

      // Offline writes must flush on reconnect without exposing a credential.
      await context.setOffline(true);
      const offlineTitle = `${platform} offline session note`;
      await openComposer();
      await page.locator('.note-title[contenteditable]:visible').first().fill(offlineTitle);
      await closeComposer();
      await page.getByText(offlineTitle, { exact: true }).first().waitFor();
      await context.setOffline(false);
      await until(async () => (await notes()).some(note => note.noteTitle === offlineTitle), 'offline note did not sync after reconnect');
      await until(() => wsUrls.length >= 2, 'realtime did not reconnect');
      assert.deepEqual(apiFailures, [], 'authenticated app requests must not fail');
      assert.ok(noteRequests.length > 0);
      for (const headers of noteRequests) {
        if (usesCookie) assert.equal(headers.authorization, undefined);
        else {
          assert.equal(headers.authorization, `Bearer ${stored.token}`);
          if (platform !== 'web') assert.equal(headers['x-kept-test-gateway'], 'native-contract');
        }
      }

      if (usesCookie) {
        assert.ok((await api('/users/me/oauth-access/enable', { method: 'POST', data: {} })).ok());
        const client = await (await context.request.post(fixture.origin + '/oauth/register', {
          data: { client_name: 'Browser regression', redirect_uris: ['http://localhost:9876/callback'], token_endpoint_auth_method: 'none' }
        })).json();
        const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://localhost:9876/callback',
          response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
          scope: 'kept.read', resource: fixture.origin + '/api', state: 'browser-regression' });
        await page.goto(fixture.origin + '/oauth/authorize?' + params);
        await page.route('http://localhost:9876/callback?**', route => route.fulfill({ status: 200, body: 'Connected' }));
        const redirected = page.waitForRequest(r => r.url().startsWith('http://localhost:9876/callback?'));
        const approved = page.waitForResponse(r => r.url().endsWith('/oauth/authorize/approve'));
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        const approval = await approved;
        assert.equal(approval.status(), 200);
        assert.ok(new URL((await redirected).url()).searchParams.get('code'));
        await page.goto(pageOrigin + '/');
        await page.locator('app-notes').waitFor();
      }
      let revision = 'Legacy shared content';
      const dirty = () => ({ noteTitle: 'Shared regression' + cases[0], noteBody: revision + cases.join('<br>'),
        checkBoxes: [{ id: 1, data: cases[0] + 'Checklist text', done: false, indentLevel: 2 }] });
      await page.route('**/*', async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.resourceType() === 'document') {
          const response = await route.fetch();
          const headers = { ...response.headers() };
          delete headers['content-security-policy'];
          return route.fulfill({ response, headers });
        }
        if (request.method() === 'GET' && /^\/api\/notes(?:\/\d+)?$/.test(pathname)) {
          const response = await route.fetch();
          const data = await response.json();
          const alter = note => note.id === shared.id ? { ...note, ...dirty() } : note;
          return route.fulfill({ response, json: Array.isArray(data) ? data.map(alter) : (data.notes ? { ...data, notes: data.notes.map(alter) } : alter(data)) });
        }
        return route.continue();
      });
      await page.addInitScript(() => { window.__noteXss = 0; });
      await page.reload();
      const unsafeCard = page.locator(`[data-note-id="${shared.id}"]`);
      await unsafeCard.waitFor();
      await page.getByPlaceholder('Search your notes', { exact: true }).fill('Shared regression');
      await unsafeCard.waitFor();
      await page.getByPlaceholder('Search your notes', { exact: true }).fill('');
      await unsafeCard.locator('.title').click();
      await page.locator('.note-body[contenteditable]:visible').waitFor();
      revision = 'Live shared revision';
      const changed = await fetch(fixture.origin + '/api/notes/' + shared.id, { method: 'PATCH', headers: {
        Authorization: 'Bearer ' + attacker.token, 'Content-Type': 'application/json'
      }, body: JSON.stringify({ noteBody: revision }) });
      assert.equal(changed.status, 204);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.note-body')).some(element => element.textContent.includes('Live shared revision')));
      await closeComposer();
      assert.equal(await page.evaluate(() => window.__noteXss), 0, 'legacy list/editor/search/live-update HTML must not execute without CSP');
      await page.unrouteAll({ behavior: 'wait' });

      // Seed an actual old IndexedDB note, then reopen with the API unavailable.
      await page.evaluate(async ({ id, dirty }) => {
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open('kept-offline-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('notes', 'readwrite'); const store = tx.objectStore('notes');
          const request = store.openCursor();
          request.onsuccess = () => { const cursor = request.result; if (!cursor) return;
            if (cursor.value.value.id === id) cursor.update({ ...cursor.value, value: { ...cursor.value.value, ...dirty } });
            cursor.continue(); };
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        db.close();
      }, { id: shared.id, dirty: dirty() });
      await page.route('**/api/**', route => route.abort());
      await page.route('**/*', async route => {
        if (route.request().resourceType() !== 'document') return route.fallback();
        const response = await route.fetch(); const headers = { ...response.headers() }; delete headers['content-security-policy'];
        return route.fulfill({ response, headers });
      });
      await page.reload();
      await page.locator(`[data-note-id="${shared.id}"]`).waitFor();
      await page.locator(`[data-note-id="${shared.id}"] .title`).click();
      await page.locator('.note-body[contenteditable]:visible').waitFor();
      assert.equal(await page.evaluate(() => window.__noteXss), 0, 'old offline note must not execute without CSP or API sanitization');
      await closeComposer();
      await page.unrouteAll({ behavior: 'wait' });
      await page.unroute('**/api/**');
      await page.reload();
      await page.locator('app-notes').waitFor();
      // Sidebar logout exercises AuthService rather than a direct API request.
      await page.locator('app-sidenav .item').filter({ hasText: 'Sign out' }).evaluate(element => element.click());
      await page.waitForURL('**/login');
      assert.equal(await page.evaluate(() => localStorage.getItem('gk_session')), null);
      await page.reload();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      console.log(`${platform}: rich editing, inline images, drawings, links, offline sync, reconnect, downloads, legacy/shared/cached XSS and logout passed`);
    } catch (error) {
      console.error(platform, error);
      await page.screenshot({ path: `/tmp/kept-note-html-${platform}-failure.png` }).catch(() => {});
      throw error;
    } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); }
  }
} finally {
  await browser?.close();
  await fixture.close();
}
