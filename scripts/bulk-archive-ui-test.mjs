import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'bulk-archive', password: 'isolated-bulk-archive-password' };
  const setup = await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  assert.equal(setup.status, 201);
  const login = await (await fetch(fixture.origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).json();
  async function api(path, body) {
    const response = await fetch(fixture.origin + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  }
  await api('/users/me/mark-demo-notes-created', {});
  const notes = [];
  for (const title of ['First archived note', 'Second archived note']) {
    notes.push(await api('/notes', { noteTitle: title, noteBody: 'Keep this content', archived: true,
      labels: [], images: [], checkBoxes: [] }));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
  assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
    data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
  })).ok());
  await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const card = note => page.locator(`app-notes [data-note-id="${note.id}"]`);
  async function selectNotes() {
    for (const note of notes) {
      await card(note).waitFor();
      await card(note).hover();
      await card(note).locator('.check-icon').click();
      await page.locator(`app-notes [data-note-id="${note.id}"].selected`).waitFor();
    }
    assert.equal(await page.locator('.selection-count').innerText(), '2 selected');
  }
  async function checkAction(name, asset) {
    const button = page.locator('.selection-actions').getByRole('button', { name, exact: true });
    await button.waitFor();
    assert.equal(await button.getAttribute('data-pop'), name);
    assert.match(await button.evaluate(element => getComputedStyle(element, '::after').maskImage), new RegExp(`/${asset}\\.svg`));
    return button;
  }
  async function waitForSaved(archived) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const saved = await Promise.all(notes.map(note => api(`/notes/${note.id}`)));
      if (saved.every(note => note.archived === archived)) return;
      await delay(100);
    }
    assert.fail(`Selected notes were not saved with archived=${archived}`);
  }
  await page.goto(fixture.origin + '/archive');
  await selectNotes();
  await (await checkAction('Unarchive', 'unarchive')).click();
  await page.locator('.selection-navbar').waitFor({ state: 'hidden' });
  await waitForSaved(false);
  for (const note of notes) {
    assert.equal((await api(`/notes/${note.id}`)).archived, false);
    await card(note).waitFor({ state: 'hidden' });
  }
  await page.goto(fixture.origin);
  await selectNotes();
  await (await checkAction('Archive', 'archive2')).click();
  await page.locator('.selection-navbar').waitFor({ state: 'hidden' });
  await waitForSaved(true);
  for (const note of notes) {
    await card(note).waitFor({ state: 'hidden' });
    assert.equal((await api(`/notes/${note.id}`)).archived, true);
  }
  await page.goto(fixture.origin + '/archive');
  for (const note of notes) await card(note).waitFor();
  assert.deepEqual(errors, []);
  console.log('Bulk Archive/Unarchive: icon, tooltip, accessible name, persisted restoration, selection clearing and archive round-trip passed.');
} finally {
  await browser?.close();
  await fixture.close();
}
