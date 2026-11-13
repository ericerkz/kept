import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Use real note writes and sync, not injected UI state.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'label-owner', password: 'isolated-label-test-password' };
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
  await api('/labels', { name: 'Catalog label' });
  const note = await api('/notes', {
    noteTitle: 'Highlight regression', noteBody: 'Before editing', binder: 'Regression binder',
    labels: ['Catalog label', 'Note label', 'Other note label'].map(name => ({ name, added: true })),
    images: [], checkBoxes: []
  });
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
