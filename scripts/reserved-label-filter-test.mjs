import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Notes, label creation, assignment and archive use the normal UI.
for (const engine of [chromium, firefox]) {
  const fixture = await startFixture();
  let browser;
  try {
    const credentials = { username: 'label-filter', password: 'isolated-label-filter-password' };
    let token;
    async function api(path, data) {
      const response = await fetch(fixture.origin + '/api' + path, {
        method: data ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: data ? JSON.stringify(data) : undefined
      });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }
    await api('/setup/admin', credentials);
    token = (await api('/auth/login', credentials)).token;
    await api('/users/me/mark-demo-notes-created', {});
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
    assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
      data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
    })).ok());
    await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const writes = new Set();
    let lastWrite = 0;
    page.on('request', request => {
      if (request.method() !== 'GET' && request.url().includes('/api/')) {
        writes.add(request);
        lastWrite = Date.now();
      }
    });
    for (const event of ['requestfinished', 'requestfailed']) {
      page.on(event, request => { if (writes.delete(request)) lastWrite = Date.now(); });
    }
    async function settle() {
      const entered = Date.now();
      while (writes.size || Date.now() - Math.max(lastWrite, entered) < 2500) {
        assert.ok(Date.now() - entered < 20000, 'writes settle before checking saved state');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await page.waitForLoadState('networkidle');
    }
    const cards = () => page.locator('app-notes [data-note-id]').evaluateAll(
      elements => elements.map(element => Number(element.dataset.noteId)).sort((a, b) => a - b)
    );
    await page.goto(fixture.origin);
    await page.locator('app-notes').waitFor();
    await settle();
    for (const title of ['Active labelled note', 'Unrelated archived note']) {
      await page.getByPlaceholder('Take a note…').first().click();
      await page.locator('app-input .note-title[contenteditable]:visible').fill(title);
      await page.locator('app-input .note-body[contenteditable]:visible').fill('Ordinary saved content');
      await page.locator('app-input .note-main:visible .close-btn').click();
      await settle();
    }
    const saved = await api('/notes');
    const active = saved.find(note => note.noteTitle === 'Active labelled note');
    const archived = saved.find(note => note.noteTitle === 'Unrelated archived note');
    assert.ok(active?.id > 0 && archived?.id > 0, 'both UI-created notes have synced server IDs');
    await page.getByRole('button', { name: 'Edit labels', exact: true }).click();
    await page.getByPlaceholder('Create new label', { exact: true }).fill('archived');
    await page.keyboard.press('Enter');
    await settle();
    await page.locator('app-sidenav .modal-container:visible .footer').getByText('Done', { exact: true }).click();
    const activeCard = page.locator(`app-notes [data-note-id="${active.id}"]`);
    await activeCard.hover();
    await activeCard.locator('.more').click();
    await page.locator('app-notes .moreMenu[data-is-tooltip-open="true"]').getByText('Add label', { exact: true }).click();
    await page.locator('app-notes .labelMenu[data-is-tooltip-open="true"] .label-list').filter({ hasText: /^archived$/ }).click();
    await page.locator('app-navbar input[placeholder]').click();
    await settle();
    const archivedCard = page.locator(`app-notes [data-note-id="${archived.id}"]`);
    await archivedCard.hover();
    await archivedCard.locator('.archive.H').click();
    await settle();
    const before = await api('/notes');
    assert.equal(before.find(note => note.id === active.id).archived, false);
    assert.ok(before.find(note => note.id === active.id).labels.some(label => label.name === 'archived' && label.added));
    assert.equal(before.find(note => note.id === archived.id).archived, true);
    assert.equal(before.find(note => note.id === archived.id).labels.length, 0);
    await page.locator('app-sidenav .is-label[title="archived"]').click();
    await settle();
    assert.equal(new URL(page.url()).pathname, '/label/archived');
    assert.deepEqual(await cards(), [active.id], 'label selects the labelled active note, not the Archive collection');
    await page.reload();
    await page.locator('app-notes').waitFor();
    await settle();
    assert.deepEqual(await cards(), [active.id], 'label results survive reload');
    await page.locator('app-sidenav [routerLink="/archive"]').click();
    await settle();
    assert.deepEqual(await cards(), [archived.id], 'built-in Archive still selects the unrelated archived note');
    await page.reload();
    await page.locator('app-notes').waitFor();
    await settle();
    assert.deepEqual(await cards(), [archived.id], 'Archive results survive reload');
    assert.deepEqual(await api('/notes'), before, 'navigation and reload do not change persisted note data');
    console.log(`${engine.name()}: UI-created archived label, sync, reload and built-in Archive passed (${fixture.origin})`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
