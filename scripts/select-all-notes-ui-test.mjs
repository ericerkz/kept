import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. All users, notes and servers are disposable fixtures.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'select-all', password: 'isolated-selection-password' };
  let token;
  async function api(path, body) {
    const response = await fetch(fixture.origin + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  }
  await api('/setup/admin', credentials);
  token = (await api('/auth/login', credentials)).token;
  await api('/users/me/mark-demo-notes-created', {});
  await api('/labels', { name: 'Selection label' });
  const notes = [];
  for (let index = 0; index < 90; index++) {
    notes.push(await api('/notes', {
      noteTitle: `Selection sample ${index}`, noteBody: 'Text for native selection',
      archived: index === 0, trashed: index === 1, binder: index === 2 ? 'Selection binder' : '',
      pinned: index % 2 === 0, labels: index < 5 ? [{ name: 'Selection label', added: true }] : [],
      images: [], checkBoxes: []
    }));
  }
  const initial = await Promise.all(notes.map(note => api(`/notes/${note.id}`)));
  for (const engine of [chromium, firefox]) {
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
    assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
      data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
    })).ok());
    await context.addInitScript(() => {
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
      localStorage.setItem('kept_search_scope', 'current');
      window.addEventListener('keydown', event => { window.selectionKeyPrevented = event.defaultPrevented; });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cards = page.locator('app-notes .note-container');
    const clear = page.getByRole('button', { name: 'Clear selection', exact: true });
    const selectAll = page.getByRole('button', { name: 'Select all', exact: true });
    async function checkCount(count) {
      await page.waitForFunction(count => document.querySelector('.selection-count')?.textContent.trim() === `${count} selected`, count);
    }
    async function browse(path) {
      await page.goto(fixture.origin + path);
      await cards.first().waitFor();
      await page.mouse.click(1260, 850);
    }
    const cases = [
      ['/', initial.filter(note => !note.archived && !note.trashed && !note.binder)],
      ['/archive', initial.filter(note => note.archived && !note.trashed)],
      ['/trash', initial.filter(note => note.trashed)],
      ['/label/Selection%20label', initial.filter(note => !note.trashed && note.labels.some(label => label.added))],
      ['/binder/Selection%20binder', initial.filter(note => note.binder)]
    ];
    for (const [path, applicable] of cases) {
      await browse(path);
      await page.keyboard.press('Control+a');
      await checkCount(applicable.length);
      await selectAll.click();
      await checkCount(applicable.length);
      const rendered = await cards.evaluateAll(cards => cards.filter(card => card.classList.contains('selected')).map(card => Number(card.dataset.noteId)));
      assert.ok(rendered.every(id => applicable.some(note => note.id === id)), 'no hidden section notes selected');
      await clear.click();
      assert.equal(await page.locator('app-notes .note-container.selected').count(), 0);
      await page.keyboard.press('Meta+a');
      await checkCount(applicable.length);
      await page.keyboard.press('Escape');
      await clear.waitFor({ state: 'hidden' });
      console.log(`${engine.name()}: ${path}: ${applicable.length} notes selected by both keyboard modifiers`);
    }

    await browse('/');
    // Start with a single card, then keyboard-activate the labeled toolbar button.
    await cards.first().hover();
    await cards.first().locator('.check-icon').click();
    await checkCount(1);
    assert.equal(await selectAll.getAttribute('title'), 'Select all');
    await selectAll.focus();
    await page.keyboard.press('Enter');
    await checkCount(cases[0][1].length);
    await clear.click();

    const search = page.locator('app-navbar input.input');
    await search.fill('zzzzzzzzzzzz');
    await cards.first().waitFor({ state: 'hidden' });
    // Native text selection in the search field must not start note selection.
    await page.keyboard.press('Control+a');
    assert.equal(await search.evaluate(input => input.selectionEnd - input.selectionStart), 12);
    assert.equal(await clear.count(), 0);
    assert.equal(await page.evaluate(() => window.selectionKeyPrevented), false);
    await search.blur();
    await page.keyboard.press('Control+a');
    assert.equal(await clear.count(), 0, 'zero matches do not show a selection toolbar');
    await search.fill('Selection sample 89');
    await cards.first().waitFor();
    await search.blur();
    // Fuzzy search may match adjacent numbers; compare selection to the actual filtered grid.
    const matches = await cards.count();
    await page.keyboard.press('Control+a');
    await checkCount(matches);
    await clear.click();
    await search.fill('');

    await cards.first().locator('.title').click();
    const editor = page.locator('app-notes .modal app-input');
    const body = editor.locator('.note-body[contenteditable]');
    await body.waitFor();
    await body.focus();
    await page.keyboard.press('Control+a');
    assert.equal(await page.evaluate(() => getSelection().toString()), 'Text for native selection');
    assert.equal(await page.evaluate(() => window.selectionKeyPrevented), false);
    await page.keyboard.press('Meta+a');
    assert.equal(await page.evaluate(() => window.selectionKeyPrevented), false);
    assert.equal(await clear.count(), 0);
    const close = editor.getByRole('button', { name: 'Close', exact: true });
    await close.focus();
    await page.keyboard.press('Control+a');
    assert.equal(await clear.count(), 0, 'editor controls keep native keyboard handling');
    await close.click();
    await editor.waitFor({ state: 'hidden' });

    // The older catalog dialogs have no role="dialog"; their controls are still off-limits.
    const editLabels = page.getByRole('button', { name: 'Edit labels', exact: true });
    if (!await editLabels.isVisible()) await page.locator('app-navbar .menu-icon').click();
    await editLabels.click();
    const catalog = page.locator('app-sidenav .modal-container:visible');
    const done = catalog.locator('.footer [tabindex="0"]');
    await done.focus();
    await page.keyboard.press('Control+a');
    assert.equal(await page.evaluate(() => window.selectionKeyPrevented), false);
    assert.equal(await clear.count(), 0);
    await done.click();
    await catalog.waitFor({ state: 'hidden' });

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const drawerBackdrop = page.locator('.sidebar-backdrop.is-open');
      if (await drawerBackdrop.isVisible()) await drawerBackdrop.click({ position: { x: width - 4, y: 600 } });
      await cards.first().hover();
      await cards.first().locator('.check-icon').click();
      await checkCount(1);
      await selectAll.click();
      await checkCount(cases[0][1].length);
      const bounds = await page.locator('.selection-navbar button').evaluateAll(buttons => buttons.map(button => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right, height: box.height };
      }));
      assert.ok(bounds.every(box => box.left >= 0 && box.right <= width && box.height >= 32),
        `${width}px toolbar controls fit and remain tappable: ${JSON.stringify(bounds)}`);
      await clear.click();
    }
    const saved = await Promise.all(notes.map(note => api(`/notes/${note.id}`)));
    assert.deepEqual(saved.map(note => [note.id, note.archived, note.trashed, note.noteBody]),
      initial.map(note => [note.id, note.archived, note.trashed, note.noteBody]), 'selection never archives, deletes or edits notes');
    assert.deepEqual(errors, []);
    await browser.close();
    browser = undefined;
    console.log(`${engine.name()}: button keyboard activation, search, native editor selection, clear, and mobile layout passed`);
  }
} finally {
  await browser?.close();
  await fixture.close();
}
