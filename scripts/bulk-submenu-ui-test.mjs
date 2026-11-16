import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

let fixture, browser, token;
const credentials = { username: 'bulk-submenu', password: 'isolated-bulk-submenu-password' };
const engine = process.env.BROWSER === 'firefox' ? firefox : chromium;
async function api(path, body) {
  const response = await fetch(fixture.origin + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Persisted bulk update did not settle');
}
try {
    browser = await engine.launch({ headless: true });
    for (const width of [1280, 390]) {
      fixture = await startFixture();
      token = undefined;
      await api('/setup/admin', credentials);
      token = (await api('/auth/login', credentials)).token;
      await api('/users/me/mark-demo-notes-created', {});
      const labels = [];
      for (const name of ['Projects', 'Personal']) labels.push(await api('/labels', { name }));
      await api('/notes', { noteTitle: 'Binder catalogue fixture', archived: true,
        binder: 'Fixture Binder', labels: [], images: [], checkBoxes: [] });
      const notes = [];
      for (const index of [1, 2]) notes.push(await api('/notes', {
        noteTitle: `${engine.name()} ${width} note ${index}`, noteBody: 'Saved fixture',
        labels: [], images: [], checkBoxes: []
      }));
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: 'block' });
      const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
      assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
        data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
      })).ok());
      await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(fixture.origin);
      const more = page.locator('.selection-actions .more');
      const menu = page.locator('app-navbar .selectionMoreMenu');
      const labelMenu = page.locator('app-navbar .labelMenu:not(.binderMenu)');
      const binderMenu = page.locator('app-navbar .binderMenu');
      const openCount = () => page.locator('app-navbar [data-is-tooltip-open="true"]').count();
      async function select() {
        for (const note of notes) {
          const card = page.locator(`app-notes [data-note-id="${note.id}"]`);
          await card.hover();
          await card.locator('.check-icon').click();
          await page.locator(`app-notes [data-note-id="${note.id}"].selected`).waitFor();
        }
      }
      async function open(action) {
        await more.click();
        await menu.getByText(action, { exact: true }).click();
      }
      async function persisted(predicate) {
        await eventually(async () => (await Promise.all(notes.map(note => api(`/notes/${note.id}`)))).every(predicate));
      }
      await select();
      await open('Add label');
      for (const [name, added] of [['Projects', true], ['Personal', true], ['Projects', false], ['Projects', true]]) {
        await page.waitForLoadState('networkidle');
        await labelMenu.locator('.label-list').filter({ hasText: name }).click();
        await labelMenu.locator('.label-list').filter({ hasText: name }).locator('.check-icon.done')
          .waitFor({ state: added ? 'visible' : 'hidden' });
        await persisted(note => note.labels.some(label => label.name === name && label.added) === added);
        assert.equal(await labelMenu.getAttribute('data-is-tooltip-open'), 'true', 'label toggles keep the picker open');
      }
      await persisted(note => labels.every(label => note.labels.some(item => item.id === label.id && item.added)));
      await more.click();
      assert.equal(await labelMenu.getAttribute('data-is-tooltip-open'), 'false', 'reopening More closes the label picker');
      assert.equal(await openCount(), 1);
      await menu.getByText('Move to binder', { exact: true }).click();
      await more.click();
      assert.equal(await binderMenu.getAttribute('data-is-tooltip-open'), 'false', 'reopening More closes the binder picker');
      assert.equal(await openCount(), 1);
      await menu.getByText('Add label', { exact: true }).click();
      await page.locator('app-notes p[_title]:visible').first().click({ position: { x: 2, y: 2 } });
      assert.equal(await openCount(), 0, 'outside click dismisses the label submenu');
      await open('Move to binder');
      await page.locator('app-notes p[_title]:visible').first().click({ position: { x: 2, y: 2 } });
      assert.equal(await openCount(), 0, 'outside click dismisses the binder submenu');
      await more.focus();
      await page.keyboard.press('Enter');
      await menu.waitFor({ state: 'visible' });
      await page.keyboard.press('Enter');
      assert.equal(await openCount(), 0, 'keyboard activation toggles More closed');
      for (let repeat = 0; repeat < 3; repeat++) {
        await open('Move to binder');
        await more.click();
        assert.equal(await openCount(), 1);
        await more.click();
        assert.equal(await openCount(), 0);
      }
      await open('Move to binder');
      await binderMenu.locator('.label-list').filter({ hasText: 'Fixture Binder' }).click();
      await persisted(note => note.binder === 'Fixture Binder');
      assert.equal(await more.count(), 0, 'choosing a binder clears selection');
      assert.equal(await openCount(), 0);
      await page.goto(fixture.origin + '/binder/Fixture%20Binder');
      await select();
      await page.locator('.selection-actions .archive').click();
      await persisted(note => note.archived && !note.trashed);
      await page.goto(fixture.origin + '/archive');
      await select();
      await open('Delete note');
      await persisted(note => note.trashed);
      await page.goto(fixture.origin + '/trash');
      for (const note of notes) await page.locator(`app-notes [data-note-id="${note.id}"]`).waitFor();
      assert.deepEqual(errors, []);
      console.log(`${engine.name()} ${width}px: label/binder reopen, multiple labels, outside dismissal, keyboard toggle, repeated toggles, binder selection, bulk archive/trash passed`);
      await context.close();
      await fixture.close();
      fixture = undefined;
    }
} finally {
  await browser?.close();
  await fixture?.close();
}
