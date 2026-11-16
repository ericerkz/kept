import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Use real note writes and sync, not injected UI state.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'label-owner', password: 'isolated-label-test-password' };
  let token;
  async function api(path, data, bearer = token, method = data ? 'POST' : 'GET') {
    const response = await fetch(fixture.origin + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: data ? JSON.stringify(data) : undefined
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  }
  await api('/setup/admin', credentials);
  const login = await api('/auth/login', credentials);
  token = login.token;
  await api('/users/me/mark-demo-notes-created', {});
  await api('/labels', { name: 'Catalog label' });
  const note = await api('/notes', {
    noteTitle: 'Highlight regression', noteBody: 'Before editing', binder: 'Regression binder',
    labels: ['Catalog label', 'Note label', 'Other note label'].map(name => ({ name, added: true })),
    images: [], checkBoxes: []
  });
  const homeNote = await api('/notes', {
    noteTitle: 'Home highlight', noteBody: 'Open without leaving Notes', images: [], checkBoxes: [], labels: []
  });
  const encodedName = 'Znaky / ? # % +';
  for (const name of [encodedName, encodedName + ' další']) {
    await api('/notes', {
      noteTitle: name, noteBody: 'Encoded catalog route', binder: name,
      labels: [{ name, added: true }], images: [], checkBoxes: []
    });
  }
  const otherCredentials = { username: 'binder-owner', password: credentials.password };
  await api('/users', otherCredentials);
  const otherToken = (await api('/auth/login', otherCredentials)).token;
  await api('/users/me/mark-demo-notes-created', {}, otherToken);
  const receivedNote = await api('/notes', {
    noteTitle: 'Received highlight', noteBody: 'Shared binder route', binder: 'Regression binder',
    labels: [], images: [], checkBoxes: []
  }, otherToken);
  const receivedBinder = (await api('/binders', undefined, otherToken)).binders
    .find(binder => binder.name === 'Regression binder');
  await api(`/binders/${receivedBinder.id}/members`, { userIds: [login.user.id] }, otherToken, 'PUT');
  async function waitForSaved(pinned, text) {
    for (let attempt = 0; ; attempt++) {
      const saved = await api(`/notes/${note.id}`);
      if (saved.pinned === pinned && saved.noteBody.includes(text)) return;
      assert.ok(attempt < 100, 'edited content and pin reach the isolated server');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  for (const engine of [chromium, firefox]) {
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
      localStorage.setItem('kept_sidebar_collapsed', 'false');
    });
    const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
    assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
      data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
    })).ok());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(fixture.origin);

    async function assertActive(row, message) {
      await row.waitFor();
      assert.equal(await page.locator('app-sidenav .item.active').count(), 1, message);
      assert.equal(await row.evaluate(element => element.classList.contains('active')), true, message);
    }
    const editor = page.locator('app-notes .modal app-input');
    const body = editor.locator('.note-body[contenteditable]');
    const notesRow = page.locator('.sidenav-top .item').filter({ hasText: /^Notes$/ });
    const homeCard = page.locator(`app-notes [data-note-id="${homeNote.id}"]`);
    await homeCard.waitFor();
    await assertActive(notesRow, 'Notes alone is active on home');
    await homeCard.locator('.check-icon').click();
    await page.locator(`app-notes .selected[data-note-id="${homeNote.id}"]`).waitFor();
    assert.equal(page.url(), fixture.origin + '/', 'multi-select does not navigate');
    await assertActive(notesRow, 'multi-select keeps Notes active');
    await page.keyboard.press('Escape');
    await homeCard.locator('.title').click();
    await body.waitFor();
    await page.waitForURL(url => url.searchParams.has('note'));
    await assertActive(notesRow, 'opening an editor keeps Notes active');
    await page.goBack();
    await editor.waitFor({ state: 'hidden' });
    await assertActive(notesRow, 'Back keeps Notes active');
    await page.goForward();
    await body.waitFor();
    await assertActive(notesRow, 'Forward keeps Notes active');
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    assert.equal(page.url(), fixture.origin + '/');
    await assertActive(notesRow, 'closing an editor keeps Notes active');

    const routes = [
      ['/', notesRow, homeNote.id],
      ...['reminders', 'attachments', 'shared', 'archive', 'trash'].map(path => [
        '/' + path, page.locator('app-sidenav .item').filter({ hasText: new RegExp(`^${path}$`, 'i') }), homeNote.id
      ]),
      ...['label', 'binder'].flatMap(section => [encodedName, encodedName + ' další'].map(name => [
        `/${section}/${encodeURIComponent(name)}`, page.locator(`.is-${section}[title="${name}"]`), note.id
      ])),
      [`/shared-binder/${receivedBinder.id}`, page.locator('.received-binder'), receivedNote.id]
    ];
    for (const [path, row, id] of routes) {
      await page.goto(fixture.origin + path + '?note=' + id + '&sidebar=1#editor');
      await body.waitFor();
      await assertActive(row, `direct editor link stays in ${path}, without activating Notes elsewhere`);
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      await page.waitForURL(fixture.origin + path + '?sidebar=1#editor');
      await assertActive(row, `closing direct editor link keeps ${path} active`);
      if (path !== '/') {
        await page.goto(fixture.origin + path + ';sidebar=1');
        await assertActive(row, `matrix parameters keep ${path} active`);
      }
    }
    // These routes render separate pages, not the notes/sidebar layout.
    for (const path of ['/users', '/settings']) {
      await page.goto(fixture.origin + path);
      await page.locator('.auth-page').waitFor();
      assert.equal(await page.locator('app-sidenav .item.active').count(), 0, `${path} must not activate Notes`);
    }
    await page.goto(fixture.origin);
    await homeCard.waitFor();
    console.log(`${engine.name()}: section highlights, selection, editor history, direct links and encoded catalogs passed.`);

    for (const [section, name] of [['label', 'Catalog label'], ['label', 'Note label'], ['binder', 'Regression binder']]) {
      await page.locator(`.is-${section}[title="${name}"]`).click();
      const row = page.locator(`.is-${section}.active`);
      await row.waitFor();
      assert.equal(await row.getAttribute('title'), name);
      const url = page.url();
      await page.evaluate(section => {
        const selector = `#sidebar-${section}s .is-${section}`;
        const rows = [...document.querySelectorAll(selector)];
        window.labelHighlightProbe = { selector, rows, mutations: [] };
        window.labelHighlightObserver?.disconnect();
        window.labelHighlightObserver = new MutationObserver(records => {
          for (const record of records) {
            if (record.type === 'attributes' && record.oldValue === record.target.className) continue;
            if (record.type === 'childList' || record.target.matches(selector)) {
              window.labelHighlightProbe.mutations.push({
                type: record.type, oldClass: record.oldValue, newClass: record.target.className, url: location.href
              });
            }
          }
        });
        window.labelHighlightObserver.observe(document.querySelector(`#sidebar-${section}s`), {
          childList: true, subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true
        });
      }, section);
      const card = page.locator(`app-notes .note-container[data-note-id="${note.id}"]`);
      await card.locator('.title').click();
      const editor = page.locator('app-notes .modal app-input');
      const body = editor.locator('.note-body[contenteditable]');
      await body.waitFor();
      await page.waitForURL(url => url.searchParams.get('note') === String(note.id));
      assert.deepEqual(await page.locator('.is-label.active, .is-binder.active').evaluateAll(rows => rows.map(row => row.title)),
        [name], 'opening a note must keep its label or binder highlighted');
      const text = `${engine.name()}: edited in ${name}`;
      await body.fill(text);
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      await page.waitForFunction(text => [...document.querySelectorAll('app-notes .note-container')]
        .some(card => card.textContent.includes(text)), text);
      await card.locator('.pin-icon').click();
      await page.waitForFunction(id => document.querySelector(`.note-container[data-note-id="${id}"] .pin-icon.pinned`), note.id);
      await waitForSaved(true, text);
      await page.waitForFunction(() => !document.querySelector('.account-avatar.is-syncing'));

      const evidence = await page.evaluate(() => ({
        sameRows: window.labelHighlightProbe.rows.every((row, index) =>
          row === document.querySelectorAll(window.labelHighlightProbe.selector)[index] && row.isConnected),
        mutations: window.labelHighlightProbe.mutations,
        active: [...document.querySelectorAll('.is-label.active, .is-binder.active')].map(row => row.title)
      }));
      console.log(`${engine.name()} ${name}: ${JSON.stringify({
        sameRows: evidence.sameRows, active: evidence.active,
        mutationCount: evidence.mutations.length, firstMutations: evidence.mutations.slice(0, 3)
      })}`);
      assert.equal(page.url(), url, 'note edits do not navigate away from the selected label');
      assert.deepEqual(evidence.active, [name]);
      assert.equal(evidence.sameRows, true, 'note updates must preserve sidebar label DOM identity');
      assert.deepEqual(evidence.mutations, [], 'note updates must not recreate rows or replay active highlighting');
      await card.locator('.pin-icon').click();
      await page.waitForFunction(id => document.querySelector(`.note-container[data-note-id="${id}"] .pin-icon:not(.pinned)`), note.id);
      await waitForSaved(false, text);
    }
    await browser.close();
    browser = undefined;
  }
} finally {
  await browser?.close();
  await fixture.close();
}
