const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('../test-support/session-fixture.cjs');

(async () => {
  const fixture = await startFixture();
  let browser;
  try {
    const credentials = { username: 'unicode-search', password: 'isolated-unicode-search-password' };
    const setup = await fetch(fixture.origin + '/api/setup/admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
    });
    assert.equal(setup.ok, true);
    const login = await (await fetch(fixture.origin + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
    })).json();
    async function api(path, body) {
      const response = await fetch(fixture.origin + '/api' + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.ok, true, path);
      return response.json();
    }
    await api('/users/me/mark-demo-notes-created', {});
    const cases = [
      ['工作', '普通工作记录', '<p>这是中文内容</p>'],
      ['РАБОТА', 'работа', '<p>Заметки</p>'],
      ['عمل', 'سجل عمل', ''],
      ['किताब', 'Hindi note', '<p>किताब</p>'],
      ['がく', 'Japanese note', '<p>がく</p>'],
      ['１２３', '番号１２３', ''],
    ];
    for (const [, noteTitle, noteBody] of cases) {
      await api('/notes', { noteTitle, noteBody, labels: [], images: [], checkBoxes: [] });
    }
    for (const noteTitle of ['English unrelated', 'कतब', 'かく']) {
      await api('/notes', { noteTitle, noteBody: '', labels: [], images: [], checkBoxes: [] });
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
    const response = await context.request.post(fixture.origin + '/api/auth/browser/login', {
      data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin },
    });
    assert.equal(response.ok(), true);
    await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.origin);
    const cards = page.locator('app-notes [data-note-id]');
    await page.waitForFunction(() => document.querySelectorAll('app-notes [data-note-id]').length === 9);
    const search = page.locator('app-navbar input[placeholder]');
    for (const [query, title] of cases) {
      const beforeSearch = Date.now();
      await search.fill('');
      await search.pressSequentially(query);
      await search.press('Enter');
      await page.waitForFunction(since => Object.keys(localStorage).some(key =>
        key.startsWith('kept_last_synced_at:') && Number(localStorage.getItem(key)) > since
      ), beforeSearch);
      // Check past async sync/debounce work, then verify the results stay stable.
      await page.waitForTimeout(1200);
      assert.equal(await search.inputValue(), query);
      assert.equal(await cards.count(), 1, query);
      assert.ok((await cards.innerText()).includes(title), query);
      await page.waitForTimeout(500);
      assert.equal(await cards.count(), 1, `${query}: settled results`);
      assert.ok((await cards.innerText()).includes(title), `${query}: settled title`);
      console.log(`PASS typed and settled search: ${query} → ${title}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
