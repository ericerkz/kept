import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'owner', password: 'test-mobile-close-password' };
  const api = async (path, body, token) => {
    const response = await fetch(fixture.origin + '/api' + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  await api('/setup/admin', credentials);
  await fixture.sql('UPDATE users SET demoNotesCreatedAt = ?', [new Date().toISOString()]);
  const session = await api('/auth/login', credentials);
  browser = await chromium.launch();
  for (const platform of ['ios', 'android']) {
    const note = await api('/notes', { noteTitle: `Back ${platform}`, noteBody: '<p>Before editing</p>', images: [], labels: [], checkBoxes: [] }, session.token);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
    await context.addInitScript(({ platform, session }) => {
      window.CapacitorCustomPlatform = { name: platform };
      localStorage.setItem('gk_session', JSON.stringify({ ...session.user, token: session.token }));
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
    }, { platform, session });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(fixture.origin);
    const card = page.locator(`.note-container[data-note-id="${note.id}"]`);
    await card.locator('.title').click();
    const editor = page.locator('app-notes > .modal-container app-input');
    const body = editor.locator('.note-body[contenteditable]:not(.note-body-after)');
    const back = editor.locator('.mobile-top-bar .back');
    let releaseSync;
    const syncing = new Promise(resolve => { releaseSync = resolve; });
    let syncRequests = 0;
    await page.route('**/api/sync/mutations', async route => {
      syncRequests++;
      await syncing;
      await route.continue().catch(() => {});
    });
    const finalText = `Final edit ${platform}`;
    await body.fill(finalText);
    await back.click();
    await page.locator('app-notes > .modal-container').waitFor({ state: 'hidden', timeout: 1500 });
    await page.waitForFunction(() => !document.body.classList.contains('modal-open'));
    await card.getByText(finalText, { exact: true }).waitFor();
    // Reopen while the server is still held: the saved text must already be local.
    await card.locator('.title').click();
    assert.equal(await body.textContent(), finalText);
    assert.ok(syncRequests > 0, 'the close completed with a real sync request still pending');
    await back.click();
    await page.locator('app-notes > .modal-container').waitFor({ state: 'hidden' });
    const completedSync = page.waitForResponse(response => response.url().endsWith('/api/sync/mutations') && response.ok());
    releaseSync();
    await completedSync;
    await page.unroute('**/api/sync/mutations');

    await card.locator('.title').click();
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      window.restoreNoteStorage = () => { IDBObjectStore.prototype.put = put; };
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (this.name === 'notes' && value?.value?.noteBody?.includes('Keep me in the editor')) throw new DOMException('Simulated storage failure', 'QuotaExceededError');
        return put.call(this, value, ...args);
      };
    });
    await body.fill('Keep me in the editor');
    await back.click();
    await page.getByText("Note couldn't be saved", { exact: true }).waitFor();
    assert.equal(await editor.isVisible(), true, 'a failed local save must not close or discard the edit');
    assert.equal(await body.textContent(), 'Keep me in the editor');
    await page.evaluate(() => window.restoreNoteStorage());
    await back.click();
    await page.locator('app-notes > .modal-container').waitFor({ state: 'hidden' });
    await page.locator('.mobile-compose-fab').click();
    const composer = page.locator('app-input.mobile-active');
    await composer.locator('.note-title[contenteditable]').fill(`New close ${platform}`);
    await composer.locator('.note-body[contenteditable]:not(.note-body-after)').fill('New note final text');
    await composer.locator('.mobile-top-bar .back').click();
    await composer.locator('.note-main').waitFor({ state: 'hidden', timeout: 1500 });
    const freshCard = page.locator('.note-container').filter({ has: page.locator('.title', { hasText: `New close ${platform}` }) });
    await freshCard.locator('.title').click();
    assert.equal(await body.textContent(), 'New note final text');
    await back.click();
    await page.locator('app-notes > .modal-container').waitFor({ state: 'hidden' });
    console.log(`PASS ${platform}: Back closes while sync is held, reopening shows durable text, failed storage keeps the edit open, retry saves, new-note Back preserves text`);
    await context.close();
  }
} finally { await browser?.close(); await fixture.close(); }
