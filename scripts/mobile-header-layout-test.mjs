import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
try {
  const credentials = { username: 'layout-owner', password: 'isolated-layout-test-password' };
  let token;
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(fixture.origin + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.ok(response.ok, await response.clone().text());
    return response.status === 204 ? null : response.json();
  }
  await api('/setup/admin', credentials);
  token = (await api('/auth/login', credentials)).token;
  await api('/users/me/mark-demo-notes-created', {});
  const pinned = await api('/notes', { noteTitle: 'Pinned layout check', noteBody: 'Pinned note', pinned: true, labels: [], images: [], checkBoxes: [] });
  await api('/notes', { noteTitle: 'Other layout check', noteBody: 'Other note', pinned: false, labels: [], images: [], checkBoxes: [] });

  for (const browserType of [chromium, firefox]) {
    const browser = await browserType.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 400, height: 800 }, serviceWorkers: 'block' });
      const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
      assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
        data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
      })).ok());
      await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      for (const hasPinned of [true, false]) {
        await api(`/notes/${pinned.id}`, { ...pinned, pinned: hasPinned }, 'PUT');
        for (const view of ['grid', 'list']) {
          await page.goto(fixture.origin);
          await page.evaluate(view => localStorage.setItem('kept_note_view_type', view), view);
          await page.reload();
          await page.locator('app-notes [data-note-id]').first().waitFor();
          for (const width of [400, 402, 412, 599, 600, 1000, 400]) {
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
            await page.waitForTimeout(350); // Wait for the existing resize/masonry debounce.
            const geometry = await page.evaluate(() => {
              const headings = [...document.querySelectorAll('app-notes p[_title]')];
              const heading = headings.find(element => element.getClientRects().length);
              const navbar = document.querySelector('app-navbar .navbar');
              const card = heading?.nextElementSibling?.querySelector('[data-note-id]');
              return {
                scrollY: window.scrollY,
                label: heading?.textContent.trim(),
                headingTop: heading?.getBoundingClientRect().top,
                headingBottom: heading?.getBoundingClientRect().bottom,
                navbarBottom: navbar?.getBoundingClientRect().bottom,
                cardTop: card?.getBoundingClientRect().top
              };
            });
            const description = `${browserType.name()} ${width}px ${view} pinned=${hasPinned}: ${JSON.stringify(geometry)}`;
            assert.equal(geometry.scrollY, 0, description);
            assert.equal(geometry.label, hasPinned ? 'pinned' : 'other', description);
            assert.ok(geometry.headingTop >= geometry.navbarBottom, description);
            if (width < 600) {
              assert.ok(geometry.headingTop - geometry.navbarBottom <= 24, `Excessive toolbar gap: ${description}`);
            }
            assert.ok(geometry.cardTop >= geometry.headingBottom, description);
          }
        }
      }
      await context.close();
      console.log(`${browserType.name()}: mobile header clearance passed in grid/list, with/without pinned notes, including breakpoint and resize checks.`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.close();
}
