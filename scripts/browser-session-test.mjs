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

  for (const platform of ['web', 'ios', 'android']) {
    // Disable SW interception so proxy-response fixtures are deterministic in WebKit.
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: platform === 'web' ? { width: 1440, height: 900 } : { width: 390, height: 844 } });
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
    const credentialUrls = [];
    const mediaHeaders = [];
    const wsFrames = [];
    const noteRequests = [];
    page.on('request', req => {
      const url = new URL(req.url());
      if (url.searchParams.has('token')) credentialUrls.push(req.url());
      if (url.pathname === '/api/notes') noteRequests.push(req.headers());
      if (/\/api\/(?:uploads\/images\/|admin\/backup\/download\/|proxy-image)/.test(url.pathname)) mediaHeaders.push(req.headers());
    });
    page.on('websocket', socket => {
      wsUrls.push(socket.url());
      socket.on('framereceived', event => { try { wsFrames.push(JSON.parse(event.payload).type); } catch {} });
    });
    try {
      await page.goto(pageOrigin + '/login');
      await page.getByLabel('Username', { exact: true }).fill(credentials.username);
      await page.getByLabel('Password', { exact: true }).fill(credentials.password);
      const responsePromise = page.waitForResponse(r => r.url().endsWith(platform === 'web' ? '/auth/browser/login' : '/auth/login'));
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const login = await (await responsePromise).json();
      await page.waitForURL(pageOrigin + '/');
      await page.locator('app-notes').waitFor();
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gk_session')));
      assert.equal(!!stored.token, platform !== 'web');
      if (platform === 'web') {
        assert.equal(login.token, undefined);
        assert.ok((await context.cookies()).find(c => c.name === 'kept.browser' && c.httpOnly));
        assert.ok(!(await page.evaluate(() => document.cookie)).includes('kept.browser'));
      } else {
        assert.equal(login.token, stored.token);
        assert.ok(!(await context.cookies()).some(c => c.name === 'kept.browser'), 'native login must not need cookies');
      }
      const api = async (route, options = {}) => {
        const headers = platform === 'web'
          ? { 'X-CSRF-Token': (await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json()).csrfToken }
          : { Authorization: `Bearer ${stored.token}` };
        return context.request.fetch(fixture.origin + '/api' + route, { ...options, headers });
      };
      await until(() => wsUrls.some(url => url.includes('/api/realtime')), 'realtime connection did not start');
      assert.ok(wsUrls.every(url => !new URL(url).searchParams.has('token')));
      await until(() => wsFrames.includes('ready'), 'realtime authentication did not complete');

      const openComposer = async () => {
        const placeholder = page.locator('input[placeholder="Take a note…"]:visible').first();
        if (await placeholder.isVisible()) await placeholder.click();
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
      const drawingBefore = (await notes()).length;
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
      const drawing = (await notes()).find(note => note.images?.some(image => image.id === 'drawing'));
      assert.ok(drawing, 'canvas drawing data must be retained');

      // Exercise the app's real media renderer, editor and download action.
      const image = await (await api('/uploads/images', {
        method: 'POST', multipart: { image: { name: 'pixel.png', mimeType: 'image/png',
          buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64') } }
      })).json();
      const mediaTitle = `${platform} protected media`;
      const mediaNote = await (await api('/notes', { method: 'POST', data: {
        noteTitle: mediaTitle, noteBody: `<div><img src="${image.url}" alt="inline regression"></div>`,
        images: [{ id: 'uploaded', name: 'pixel.png', dataUrl: image.url, placement: 'bottom' }]
      } })).json();
      await page.reload();
      const mediaCard = page.locator(`[data-note-id="${mediaNote.id}"]`);
      await mediaCard.waitFor();
      await until(() => mediaCard.locator('img').first().evaluate(img => img.complete && img.naturalWidth === 1), 'protected image did not render');
      if (platform !== 'web') assert.ok((await mediaCard.locator('img').first().getAttribute('src')).startsWith('blob:'));
      await page.getByText(mediaTitle, { exact: true }).first().click();
      await page.locator('.note-body[contenteditable]:visible img').first().waitFor();
      await until(() => page.locator('.note-body[contenteditable]:visible img').first().evaluate(img => img.complete && img.naturalWidth === 1), 'inline editor image did not render');
      await page.locator('.note-title[contenteditable]:visible').first().fill(mediaTitle + ' edited');
      await closeComposer();
      await until(async () => (await notes()).some(note => note.id === mediaNote.id && note.noteTitle === mediaTitle + ' edited'), 'image note edit was not saved');
      const savedMedia = await (await api('/notes/' + mediaNote.id)).json();
      assert.ok(!JSON.stringify(savedMedia).includes('blob:'), 'local rendering URLs must not be saved');
      assert.ok(!JSON.stringify(savedMedia).includes('token='), 'credentials must not be saved in image content');
      assert.ok(savedMedia.noteBody.includes(image.url));
      if (platform === 'android') {
        // Without a native bridge, exercise the existing browser fallback.
        const imageDownload = page.waitForEvent('download');
        await page.locator(`[data-note-id="${mediaNote.id}"] .note-images img`).first().dispatchEvent('contextmenu');
        assert.equal((await imageDownload).suggestedFilename(), 'pixel.png');
      }
      // Proxied SVG must remain visible without carrying its active document
      // behavior into a blob URL with the app's origin.
      await context.route(url => url.pathname === '/api/link-preview', route => route.fulfill({ headers: { 'Access-Control-Allow-Origin': pageOrigin, 'Access-Control-Allow-Credentials': 'true' }, json: {
        title: 'SVG preview regression', description: '', image: 'https://preview.invalid/thumbnail.svg',
        url: 'https://preview.invalid/article', domain: 'preview.invalid'
      } }));
      await context.route(url => url.pathname === '/api/proxy-image', route => route.fulfill({
        contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': pageOrigin, 'Access-Control-Allow-Credentials': 'true', 'Content-Security-Policy': "sandbox; script-src 'none'" },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><script>window.__proxyScriptRan=true</script><rect width="16" height="16" fill="red"/></svg>'
      }));
      const previewNote = await (await api('/notes', { method: 'POST', data: { noteTitle: '', noteBody: '<a href="https://preview.invalid/article">https://preview.invalid/article</a>' } })).json();
      await page.reload();
      const thumbnail = page.locator(`[data-note-id="${previewNote.id}"] app-link-preview img`).first();
      await thumbnail.waitFor();
      await until(() => thumbnail.evaluate(img => img.complete && img.naturalWidth === 16), 'SVG preview did not render');
      if (platform !== 'web') {
        assert.equal(await thumbnail.evaluate(async img => (await (await fetch(img.src)).blob()).type), 'image/png');
        assert.equal(await page.evaluate(() => window.__proxyScriptRan), undefined);
      }
      const backup = await (await api('/admin/backup/now', { method: 'POST', data: {} })).json();
      await page.goto(pageOrigin + '/users');
      const downloadPromise = page.waitForEvent('download');
      await page.locator('.backup-row').filter({ hasText: backup.filename }).getByRole('button', { name: 'Download', exact: true }).click();
      assert.equal((await downloadPromise).suggestedFilename(), backup.filename);
      await page.goto(pageOrigin + '/');
      await page.getByText(title, { exact: true }).first().waitFor();

      if (platform === 'web') {
        // Simulate an unavailable session bootstrap after a reload. Retain the
        // offline account partition, then obtain CSRF again when writes resume.
        await page.route('**/api/auth/browser/session', route => route.abort());
        await page.reload();
        await page.getByText(title, { exact: true }).first().waitFor();
        await page.unroute('**/api/auth/browser/session');
      }

      // Offline writes must flush on reconnect without exposing a credential.
      const readyBeforeOffline = wsFrames.filter(type => type === 'ready').length;
      await context.setOffline(true);
      await page.getByText(mediaTitle + ' edited', { exact: true }).first().click();
      await until(() => page.locator('.note-body[contenteditable]:visible img').first().evaluate(img => img.complete && img.naturalWidth === 1), 'cached image was unavailable offline');
      await closeComposer();
      const offlineTitle = `${platform} offline session note`;
      await openComposer();
      await page.locator('.note-title[contenteditable]:visible').first().fill(offlineTitle);
      await closeComposer();
      await page.getByText(offlineTitle, { exact: true }).first().waitFor();
      await fixture.restart();
      await context.setOffline(false);
      await until(async () => (await notes()).some(note => note.noteTitle === offlineTitle), 'offline note did not sync after reconnect');
      await until(() => wsFrames.filter(type => type === 'ready').length > readyBeforeOffline, 'realtime did not authenticate after reconnect');
      assert.deepEqual(apiFailures, [], 'authenticated app requests must not fail');
      assert.deepEqual(credentialUrls, [], 'no HTTP request may carry a session token in its URL');
      assert.ok(wsUrls.every(url => !new URL(url).searchParams.has('token')));
      if (platform !== 'web') {
        assert.ok(mediaHeaders.length > 0);
        for (const headers of mediaHeaders) {
          assert.equal(headers.authorization, `Bearer ${stored.token}`);
          assert.equal(headers['x-kept-test-gateway'], 'native-contract');
        }
      }
      assert.ok(noteRequests.length > 0);
      for (const headers of noteRequests) {
        if (platform === 'web') assert.equal(headers.authorization, undefined);
        else {
          assert.equal(headers.authorization, `Bearer ${stored.token}`);
          assert.equal(headers['x-kept-test-gateway'], 'native-contract');
        }
      }

      if (platform === 'web') {
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
      // Sidebar logout exercises AuthService rather than a direct API request.
      await page.locator('app-sidenav .item').filter({ hasText: 'Sign out' }).evaluate(element => element.click());
      await page.waitForURL('**/login');
      assert.equal(await page.evaluate(() => localStorage.getItem('gk_session')), null);
      await page.reload();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      console.log(`${platform}: login, reload, notes, drawing, image, backup, offline sync, realtime reconnect and logout passed`);
    } catch (error) {
      await page.screenshot({ path: `/tmp/kept-session-${platform}-failure.png` });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  await fixture.close();
}
