import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import fixtureModule from '../test-support/session-fixture.cjs';

async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for saved notes or search results');
}

for (const browserType of [chromium, firefox]) {
  const fixture = await fixtureModule.startFixture();
  let browser;
  try {
    const credentials = { username: 'year-search', password: 'isolated-year-search-password' };
    const setup = await fetch(fixture.origin + '/api/setup/admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
    });
    assert.equal(setup.ok, true);
    const login = await (await fetch(fixture.origin + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
    })).json();
    const headers = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
    await fetch(fixture.origin + '/api/users/me/mark-demo-notes-created', { method: 'POST', headers, body: '{}' });
    const savedNotes = async () => (await fetch(fixture.origin + '/api/notes', { headers })).json();

    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
    const authenticated = await context.request.post(fixture.origin + '/api/auth/browser/login', {
      data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
    });
    assert.equal(authenticated.ok(), true);
    const page = await context.newPage();
    await page.goto(fixture.origin);
    const cards = page.locator('app-notes [data-note-id]');
    for (const [title, body] of [
      ['Title with 1999', 'Title regression'],
      ['Body regression', 'Memories of 1999'],
      ['Unrelated budget', 'Budget 2000']
    ]) {
      await page.getByPlaceholder('Take a note…', { exact: true }).first().click();
      await page.locator('app-input .note-title[contenteditable]:visible').fill(title);
      await page.locator('app-input .note-body[contenteditable]:visible').fill(body);
      // Let autosave fully settle before closing, rather than testing the separate delete/save race.
      await until(async () => (await savedNotes()).some(note => note.noteTitle === title && note.noteBody.includes(body)));
      await page.getByRole('button', { name: 'Close', exact: true }).filter({ visible: true }).click();
      await until(async () => await cards.count() === (await savedNotes()).length);
    }
    // Reload from persisted data before typing any search.
    await page.reload();
    await until(async () => await cards.count() === 3);
    const search = page.locator('app-navbar input[placeholder]');
    const notes = await savedNotes();
    const ids = titles => notes.filter(note => titles.includes(note.noteTitle)).map(note => String(note.id)).sort();
    for (const [query, titles] of [
      ['1999', ['Title with 1999', 'Body regression']],
      ['title 1999', ['Title with 1999']],
      ['memories 1999', ['Body regression']],
      ['2000 budget', ['Unrelated budget']],
      ['1999 !todo', []],
      ['!date 1999', []],
      ['!date June 1999', []],
      ['!date ' + new Date().toLocaleDateString('en-CA'), ['Title with 1999', 'Body regression', 'Unrelated budget']]
    ]) {
      await search.fill('');
      await search.pressSequentially(query);
      const actualIds = async () => (await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-note-id')))).sort();
      await until(async () => JSON.stringify(await actualIds()) === JSON.stringify(ids(titles)));
      assert.deepEqual(await actualIds(), ids(titles), `${browserType.name()}: ${query}`);
      console.log(`${browserType.name()}: "${query}" => ${titles.length} expected notes`);
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
