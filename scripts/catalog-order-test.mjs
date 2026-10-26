import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Uses the production handle, scrolling and save path.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'catalog-owner', displayName: 'Owner', password: 'isolated-catalog-password' };
  let token, sequence = 0;
  async function api(path, body) {
    const response = await fetch(fixture.origin + '/api' + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  }
  await api('/setup/admin', credentials);
  token = (await api('/auth/login', credentials)).token;
  await api('/users/me/mark-demo-notes-created', {});
  for (const config of [{ engine: chromium, touch: true, viewport: { width: 390, height: 844 } },
    { engine: webkit, touch: false, viewport: { width: 1280, height: 900 } }]) {
    const seeded = await api('/sync/mutations', { protocolVersion: 2, mutations: ['binder', 'label'].flatMap(type =>
      Array.from({ length: 12 }, (_, sortOrder) => {
        const operationId = `catalog-${++sequence}`;
        return { type: `${type}.upsert`, syncId: `${type}-${sortOrder}`, operationId,
          payload: { name: `${type} ${String(sortOrder).padStart(2, '0')}`, sortOrder },
          lww: { physicalMs: Date.now(), logical: sequence, deviceId: 'catalog-test', operationId } };
      })) });
    assert.ok(seeded.results.every(result => result.ok && !result.skipped), 'fixture catalog reset is accepted');
    browser = await config.engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: config.viewport, hasTouch: config.touch, isMobile: config.touch, serviceWorkers: 'block' });
    const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
    assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
      data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
    })).ok());
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(fixture.origin);
    await page.locator('app-navbar .menu-icon').waitFor();
    if (!await page.getByRole('button', { name: 'Edit labels', exact: true }).isVisible()) await page.locator('app-navbar .menu-icon').click();
    const cdp = config.touch ? await context.newCDPSession(page) : undefined;
    async function begin(point) {
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
      else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
    }
    async function move(start, end) {
      for (let step = 1; step <= 8; step++) {
        const point = { x: start.x + (end.x - start.x) * step / 8, y: start.y + (end.y - start.y) * step / 8 };
        if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
        else await page.mouse.move(point.x, point.y);
      }
    }
    async function end(cancel = false) {
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
      else { if (cancel) await page.keyboard.press('Escape'); await page.mouse.up(); }
    }
    for (const type of ['binder', 'label']) {
      await page.getByRole('button', { name: `Edit ${type}s`, exact: true }).click();
      const list = page.locator('.modal-container:visible .label-list');
      const rows = list.locator('[data-catalog-name]');
      await rows.nth(11).waitFor({ state: 'attached' });
      const names = () => rows.locator('input').evaluateAll(inputs => inputs.map(input => input.value));
      async function savedOrder(saved) {
        // Poll in Node: this Playwright version treats a Promise predicate as
        // truthy instead of awaiting its boolean result in waitForFunction.
        for (let attempt = 0; attempt < 100; attempt++) {
          const snapshot = await api('/sync/bootstrap?protocolVersion=2');
          const ordered = snapshot[`${type}s`].sort((a, b) => a.sortOrder - b.sortOrder).map(item => item.name);
          const visible = await names();
          const ready = await page.evaluate(type => !document.querySelector('.offline-sync-state') &&
            Array.from(document.querySelectorAll(`.${type}-move`)).some(button => !button.disabled), type);
          if (ready && JSON.stringify(ordered) === JSON.stringify(saved) && JSON.stringify(visible) === JSON.stringify(saved)) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.deepEqual(await names(), saved, 'UI and server finish saving the same order');
        assert.fail('The order did not finish syncing.');
      }
      const original = await names();
      const originalFirst = await rows.first().boundingBox();
      const source = await rows.first().locator('.catalog-drag-handle').boundingBox();
      const target = await rows.nth(2).boundingBox();
      const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
      await begin(start); await move(start, { x: start.x, y: target.y + target.height - 4 });
      await page.locator('.catalog-drag-preview').waitFor();
      await page.waitForFunction(({ type, top, targetTop }) => {
        const rows = document.querySelectorAll(`.${type}-edit-row`);
        return Math.abs(rows[1].getBoundingClientRect().top - top) < 1 &&
          Math.abs(rows[0].getBoundingClientRect().top - targetTop) < 1;
      }, { type, top: originalFirst.y, targetTop: target.y });
      assert.equal(await rows.first().locator('input').evaluate(input => getComputedStyle(input).opacity), '0', 'dragged row leaves a clear insertion slot');
      await end();
      const expected = [original[1], original[2], original[0], ...original.slice(3)];
      await savedOrder(expected);
      assert.deepEqual(await names(), expected);
      const up = page.getByRole('button', { name: `Move ${expected[0]} up`, exact: true });
      assert.equal(await up.isDisabled(), true);
      const down = page.getByRole('button', { name: `Move ${expected[0]} down`, exact: true });
      await down.click();
      await savedOrder([expected[1], expected[0], ...expected.slice(2)]);
      const saved = await names();
      assert.equal(await rows.first().evaluate(row => row.getBoundingClientRect().right <= row.closest('.modal').getBoundingClientRect().right), true, 'controls fit the dialog');

      // Edge scrolling continues while holding still, and cancellation saves nothing.
      const handle = await rows.first().locator('.catalog-drag-handle').boundingBox(), bounds = await list.boundingBox();
      const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      await begin(from); await move(from, { x: from.x, y: bounds.y + bounds.height - 5 });
      await page.waitForFunction(() => document.querySelector('.modal-container[style*="block"] .label-list')?.scrollTop > 50);
      await end(true);
      await page.locator('.catalog-drag-preview').waitFor({ state: 'hidden' });
      assert.equal(await rows.evaluateAll(items => items.every(row => !row.style.transform && !row.classList.contains('catalog-drag-source'))), true, 'cancellation restores the natural row layout');
      assert.deepEqual(await names(), saved, 'cancelled dragging preserves the order');

      await savedOrder(saved);
      await page.locator('.modal-container:visible .footer').getByText('Done', { exact: true }).click();
      await page.reload(); await page.locator('app-navbar .menu-icon').waitFor();
      if (!await page.getByRole('button', { name: `Edit ${type}s`, exact: true }).isVisible()) await page.locator('app-navbar .menu-icon').click();
      await page.getByRole('button', { name: `Edit ${type}s`, exact: true }).click();
      await rows.first().waitFor();
      assert.deepEqual(await names(), saved, 'order survives reload');
      await page.locator('.modal-container:visible .footer').getByText('Done', { exact: true }).click();
      console.log(`${config.engine.name()} ${config.touch ? 'touch/phone' : 'mouse/desktop'} ${type}: drag, arrows, scrolling, cancellation and persistence passed`);
    }
    await browser.close(); browser = undefined;
  }
} finally { await browser?.close(); await fixture.close(); }
