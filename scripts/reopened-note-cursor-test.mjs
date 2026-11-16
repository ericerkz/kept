import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
try {
  browser = await (process.env.KEPT_TEST_BROWSER === 'firefox' ? firefox : chromium).launch({ headless: true });
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  const setup = await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  assert.equal(setup.status, 201);
  await fixture.sql('UPDATE users SET demoNotesCreatedAt = ?', [new Date().toISOString()]);
  let page;
  let body;
  const freshSession = async () => {
    await page?.context().close();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
    await page.goto(fixture.origin + '/login');
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('app-notes').waitFor();
    body = page.locator('.note-body[contenteditable]:visible');
  };
  const close = async () => {
    await page.locator('.note-main:visible .close-btn').click();
    await page.locator('app-notes > .modal-container').waitFor({ state: 'hidden' });
    await page.waitForURL(fixture.origin + '/');
  };
  for (const [index, [html, typedHtml]] of [
    [undefined, undefined],
    ['<p>Existing <b>bold</b> <i>italic</i></p><p><br></p><p>Last line</p>',
      '<p>XExisting <b>bold</b> <i>italic</i></p><p><br></p><p>Last line</p>'],
    ['<div><br></div><div>Intentional leading blank line</div>',
      '<div>X</div><div>Intentional leading blank line</div>'],
    ['Plain text', 'XPlain text'],
    ['', 'X'],
    ['<p><b>Bold first</b> text</p>', '<p><b>XBold first</b> text</p>'],
    ['<h2>Heading</h2><ul><li>List item</li></ul>', '<h2>XHeading</h2><ul><li>List item</li></ul>']
  ].entries()) {
    await freshSession();
    // Keep local saves stable while testing the caret, not temporary-ID sync.
    await page.context().setOffline(true);
    const title = `Reopened cursor ${index}`;
    await page.getByPlaceholder('Take a note…').first().click();
    await page.locator('.note-title[contenteditable]:visible').fill(title);
    await body.focus();
    if (html === undefined) {
      // Real typing produces different block markup in Chromium and Firefox.
      await page.keyboard.type('Existing text');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Second line');
    } else {
      await body.evaluate((element, value) => {
        element.innerHTML = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }, html);
    }
    const savedHtml = await body.innerHTML();
    const expected = typedHtml ?? savedHtml.replace('Existing text', 'XExisting text');
    await close();
    await page.locator('[data-note-id] .title').filter({ hasText: title }).click();
    assert.equal(await body.innerHTML(), savedHtml, 'reopening must preserve rich HTML and intentional blank lines');
    assert.equal(await body.evaluate(element => document.activeElement === element), true);
    // Do not click/fill the body: exercise the caret left by opening the note.
    await page.keyboard.type('X');
    assert.equal(await body.innerHTML(), expected, `first typing must stay inside the existing first line (case ${index})`);
    await close();
    await page.locator('[data-note-id] .title').filter({ hasText: title }).click();
    assert.equal(await body.innerHTML(), expected, 'the edited HTML must survive another save/reopen');
  }
  const { token } = await (await fetch(fixture.origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).json();
  const checkBoxes = [
    { id: 0, data: '<b>Parent</b>', done: false, indentLevel: 0 },
    { id: 1, data: 'Child', done: false, indentLevel: 1 }
  ];
  const response = await fetch(fixture.origin + '/api/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ noteTitle: 'Checklist preservation', noteBody: '', isCbox: true, checkBoxes })
  });
  assert.equal(response.status, 201);
  const checklist = await response.json();
  await freshSession();
  await page.locator(`[data-note-id="${checklist.id}"] .title`).click();
  await page.locator('.note-main:visible [data-cbox-id]').first().waitFor();
  assert.deepEqual(await page.locator('.note-main:visible [data-cbox-id]').evaluateAll(elements =>
    elements.map(element => element.innerHTML)), checkBoxes.map(item => item.data));
  await close();
  const savedChecklist = await (await fetch(fixture.origin + `/api/notes/${checklist.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  })).json();
  assert.deepEqual(savedChecklist.checkBoxes, checkBoxes);
  console.log('Reopened note caret, real typing, rich formatting, intentional newlines and checklist preservation passed');
} finally {
  await browser?.close();
  await fixture.close();
}
