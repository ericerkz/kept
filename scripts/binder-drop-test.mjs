import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Exercise the production drag handlers and save path.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'binder-drag-owner', displayName: 'Owner', password: 'isolated-drag-test-password' };
  let token, sequence = 0;
  async function api(path, data, method = data ? 'POST' : 'GET') {
    const response = await fetch(fixture.origin + '/api' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: data ? JSON.stringify(data) : undefined
    });
    assert.ok(response.ok, await response.clone().text());
    return response.status === 204 ? null : response.json();
  }
  await api('/setup/admin', credentials);
  const login = await api('/auth/login', credentials); token = login.token;
  await api('/users/me/mark-demo-notes-created', {});
  const binders = Array.from({ length: 30 }, (_, index) => `Binder ${String(index).padStart(2, '0')}`);
  await api('/sync/mutations', { protocolVersion: 2, mutations: binders.map((name, sortOrder) => {
    const operationId = `binder-${++sequence}`;
    return { type: 'binder.upsert', syncId: operationId, operationId, payload: { name, sortOrder },
      lww: { physicalMs: Date.now(), logical: sequence, deviceId: 'drag-test', operationId } };
  }) });
  const cases = [
    { engine: chromium, platform: 'web', touch: false, viewport: { width: 1280, height: 900 } },
    { engine: webkit, platform: 'web', touch: false, viewport: { width: 1280, height: 900 } },
    { engine: chromium, platform: 'android', touch: true, viewport: { width: 1080, height: 800 }, userAgent: 'Mozilla/5.0 (Linux; Android 16; Tablet) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' },
    { engine: webkit, platform: 'ios', touch: true, viewport: { width: 1080, height: 800 }, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1' }
  ];
  for (const config of cases) {
    const note = await api('/notes', { noteTitle: `Drag ${config.engine.name()} ${config.platform}`,
      noteBody: '<p>Preserve this full note body</p>', checkBoxes: [{ id: 5, data: 'Keep this checklist item', done: false }],
      images: [], labels: [], bgColor: '#cbf0f8' });
    const neighbour = await api('/notes', { noteTitle: 'Reorder neighbour', noteBody: 'Keep me too', images: [], labels: [], checkBoxes: [] });
    browser = await config.engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: config.viewport, screen: config.viewport, hasTouch: config.touch,
      isMobile: config.touch, userAgent: config.userAgent, serviceWorkers: 'block' });
    await context.addInitScript(({ platform, session }) => {
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
      // WebKit does not expose a constructible Touch in desktop automation.
      window.sendBinderTouch = (el, type, point) => {
        const touch = point && { identifier: 1, target: el, clientX: point.x, clientY: point.y };
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: touch ? [touch] : [] }, changedTouches: { value: touch ? [touch] : [] } });
        el.dispatchEvent(event);
      };
      if (platform !== 'web') {
        window.CapacitorCustomPlatform = { name: platform };
        localStorage.setItem('gk_session', JSON.stringify(session));
      }
    }, { platform: config.platform, session: { ...login.user, token } });
    if (config.platform === 'web') {
      const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
      assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
        data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
      })).ok());
    }
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.goto(fixture.origin);
    const card = page.locator(`app-notes .note-container[data-note-id="${note.id}"]`);
    await card.waitFor();
    const sidebar = page.locator('[sideBar]');
    if (await sidebar.evaluate(el => el.classList.contains('close'))) await page.locator('app-navbar .menu-icon').click();
    await page.getByRole('button', { name: 'Edit binders', exact: true }).waitFor();
    const target = sidebar.locator('[data-binder-drop="Binder 00"]');
    await target.scrollIntoViewIfNeeded();
    // Native desktop dragstart/drop and touch long-press share the same destination.
    if (!config.touch) {
      await card.dragTo(target);
    } else {
      const start = await card.boundingBox(), end = await target.boundingBox();
      // Exercise the same touch event handlers on both browser engines.
      await card.evaluate((el, point) => {
        window.dragTouchTarget = el;
        window.sendBinderTouch(el, 'touchstart', point);
      }, { x: start.x + start.width / 2, y: start.y + 30 });
      await page.locator('.touch-dragging-ghost').waitFor();
      await page.evaluate(point => {
        window.sendBinderTouch(window.dragTouchTarget, 'touchmove', point);
      }, { x: end.x + end.width / 2, y: end.y + end.height / 2 });
      await target.locator('xpath=self::*[contains(@class,"binder-drop-target")]').waitFor();
      await page.evaluate(() => {
        window.sendBinderTouch(window.dragTouchTarget, 'touchend');
      });
      await page.locator('.touch-dragging-ghost').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.body.style.touchAction), '', 'touch scrolling is restored');
    }
    await card.waitFor({ state: 'hidden' });
    await page.waitForFunction(async ({ id, token }) => {
      const response = await fetch(`/api/notes/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      return response.ok && (await response.json()).binder === 'Binder 00';
    }, { id: note.id, token }, { polling: 100 });
    await page.goto(fixture.origin + '/binder/Binder%2000');
    await card.waitFor();
    const saved = await api(`/notes/${note.id}`);
    assert.equal(saved.binder, 'Binder 00');
    assert.match(saved.noteBody, /Preserve this full note body/);
    assert.equal(saved.checkBoxes[0].data, 'Keep this checklist item');
    assert.equal(saved.bgColor, '#cbf0f8');
    assert.equal((await api(`/notes/${neighbour.id}`)).binder, '', 'the drag moves only its source note');
    assert.equal(await page.locator('.binder-drop-target').count(), 0);

    // Start another internal drag for edge scrolling and cancellation checks.
    await page.goto(fixture.origin);
    const remaining = page.locator(`app-notes .note-container[data-note-id="${neighbour.id}"]`);
    await remaining.waitFor();
    const begin = async () => {
      await remaining.evaluate(el => el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })));
      await sidebar.locator('xpath=self::*[contains(@class,"binder-drop-active")]').waitFor();
    };
    await begin();
    await sidebar.evaluate(el => {
      el.scrollTop = 0;
      const rect = el.getBoundingClientRect();
      document.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2, clientY: Math.min(innerHeight, rect.bottom) - 4, dataTransfer: new DataTransfer() }));
    });
    await page.waitForFunction(() => document.querySelector('[sideBar]').scrollTop > 120);
    await page.keyboard.press('Escape');
    await page.locator('.binder-drop-active').waitFor({ state: 'hidden' });
    assert.equal((await api(`/notes/${neighbour.id}`)).binder, '');
    await sidebar.evaluate(el => { el.scrollTop = 0; });
    await begin();
    await page.setViewportSize({ width: config.viewport.width - 60, height: config.viewport.height });
    await page.locator('.binder-drop-active').waitFor({ state: 'hidden' });
    await target.dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    assert.equal((await api(`/notes/${neighbour.id}`)).binder, '', 'layout changes cancel rather than move');
    // Collapsed sidebars and external drops never create a binder move.
    await page.locator('app-navbar .menu-icon').click();
    await remaining.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    assert.equal(await page.locator('.binder-drop-active').count(), 0);
    await remaining.dispatchEvent('dragend');
    assert.equal((await api(`/notes/${neighbour.id}`)).binder, '');
    console.log(`PASS ${config.engine.name()} ${config.platform}: ${config.touch ? 'touch pickup' : 'desktop drag'}, save/reload, content preservation, edge scroll, Escape/resize cancellation and collapsed sidebar`);
    await context.close(); await browser.close(); browser = undefined;
  }
} finally { await browser?.close(); await fixture.close(); }
