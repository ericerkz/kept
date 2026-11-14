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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('Could not save note')) errors.push(message.text());
  });
  await page.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
  await page.goto(fixture.origin + '/login');
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('app-notes').waitFor();
  const body = page.locator('.note-body[contenteditable]:visible');
  const count = async () => (await fixture.sql('SELECT count(*) AS n FROM notes'))[0].n;
  const localCount = store => page.evaluate(name => new Promise((resolve, reject) => {
    const request = indexedDB.open('kept-offline-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const count = db.transaction(name).objectStore(name).count();
      count.onsuccess = () => { db.close(); resolve(count.result); };
      count.onerror = () => { db.close(); reject(count.error); };
    };
  }), store);
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(message);
  };
  const open = () => page.getByPlaceholder('Take a note…').first().click();
  const clear = async () => {
    await body.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
  };
  const close = async () => {
    await page.locator('.note-main:visible .close-btn').click();
    await page.locator('app-input .note-main:visible').waitFor({ state: 'hidden' });
  };
  const noGhost = async () => {
    await until(async () => await localCount('outbox') === 0, 'discard must finish syncing');
    await until(async () => await count() === 0, 'cleared new draft must be deleted from the server');
    await page.reload();
    await page.locator('app-notes').waitFor();
    // Cover the debounce and a subsequent sync/reload, not only the hidden draft card.
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('[data-note-id]').count(), 0);
    assert.equal(await localCount('notes'), 0);
    assert.equal(await localCount('outbox'), 0);
    assert.equal(await count(), 0);
  };

  await open();
  await page.keyboard.type('Autosaved draft');
  await until(async () => await count() === 1, 'draft should autosave before clearing');
  await clear();
  await close();
  await noGhost();
  console.log('Autosaved then cleared: no persisted ghost');

  await open();
  await page.keyboard.type('Quick draft');
  await clear();
  await close();
  await noGhost();
  console.log('Cleared before debounce: no persisted ghost');

  let release;
  let intercepted;
  let fulfilled;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { intercepted = resolve; });
  const finished = new Promise(resolve => { fulfilled = resolve; });
  const routePattern = '**/api/sync/mutations';
  await page.route(routePattern, async route => {
    const response = await route.fetch();
    intercepted();
    await held;
    await route.fulfill({ response });
    fulfilled();
  });
  await open();
  await page.keyboard.type('Create response still in flight');
  await started;
  assert.equal(await count(), 1, 'the held create must already have reached the server');
  await clear();
  await close();
  release();
  await finished;
  await page.unroute(routePattern);
  await noGhost();
  console.log('In-flight create response cannot resurrect a discarded draft');

  for (const empty of ['   ', '\u200b\u200c\u200d\ufeff', '\n\n']) {
    await open();
    await page.keyboard.type('Text to erase');
    await clear();
    if (empty === '\n\n') {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    } else await page.keyboard.insertText(empty);
    await close();
    await noGhost();
  }
  console.log('Whitespace, zero-width and editor line-break placeholders are empty');

  await open();
  await page.keyboard.type('Autosaved without close');
  await until(async () => await count() === 1, 'draft should autosave');
  await clear();
  await until(async () => await count() === 0, 'clearing should discard even before closing');
  await page.keyboard.type('Typed after discard');
  await until(async () => await count() === 1, 'new typing after discard should save again');
  await clear();
  await close();
  await noGhost();

  await page.context().setOffline(true);
  await open();
  await page.keyboard.type('Offline draft');
  await until(async () => await localCount('notes') === 1, 'offline draft must be stored before clearing');
  assert.ok(await localCount('outbox') > 0, 'offline create must actually be queued');
  await clear();
  await close();
  await page.context().setOffline(false);
  await noGhost();
  console.log('Offline queued create then clear: no resurrection');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await body.click();
  await page.keyboard.type('Mobile autosaved draft');
  await until(async () => await count() === 1, 'mobile draft should autosave');
  await clear();
  await page.locator('.note-main:visible button.mobile-icon.back').click();
  await body.waitFor({ state: 'hidden' });
  await noGhost();
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('Mobile Back discards the cleared autosaved draft');

  await page.locator('[data-pop="New list"]').first().click();
  const checklistPlaceholder = page.locator('.cbox-ph-container [contenteditable]:visible');
  await checklistPlaceholder.click();
  await page.keyboard.type('Meaningful checklist row');
  await page.locator('.note-main:visible [data-cbox-id]').first().waitFor();
  await close();
  await until(async () => await count() === 1, 'checklist draft must be retained');
  await until(async () => await localCount('outbox') === 0, 'checklist draft must finish syncing');
  await page.reload();
  await page.locator('app-notes').waitFor();
  const checklist = (await fixture.sql('SELECT checkBoxes FROM notes'))[0];
  assert.ok(JSON.parse(checklist.checkBoxes).some(row => row.data.includes('Meaningful checklist row')));
  console.log('Meaningful checklist draft retained after sync and reload');

  await open();
  await page.locator('.note-title[contenteditable]:visible').fill('Title only');
  await body.click();
  await page.keyboard.type('Temporary body');
  await clear();
  await close();
  await until(async () => await count() === 2, 'title-only draft must be retained');
  await until(async () => await localCount('outbox') === 0, 'title-only draft must finish syncing before reopening as an existing note');
  await page.reload();
  await page.locator('[data-note-id] .title').filter({ hasText: 'Title only' }).click();
  await page.locator('.note-title[contenteditable]:visible').fill('');
  await close();
  await page.reload();
  await page.locator('app-notes').waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await count(), 2, 'an existing note intentionally emptied must not be discarded');
  assert.equal(await page.locator('[data-note-id]').count(), 2);
  console.log('Title-only retained; existing saved note may still be intentionally emptied');

  await open();
  await page.locator('app-input').filter({ has: body }).locator('input.image-input').setInputFiles({
    name: 'pixel.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64')
  });
  await body.locator('img.inline-note-image').waitFor();
  await close();
  await until(async () => await count() === 3, 'image-only draft must be retained');
  await until(async () => await localCount('outbox') === 0, 'image note must finish syncing');
  await page.reload();
  await page.locator('app-notes').waitFor();
  assert.equal(await count(), 3);
  assert.ok((await fixture.sql('SELECT noteBody, images FROM notes')).some(note => note.noteBody.includes('<img') || JSON.parse(note.images || '[]').length));
  console.log('Image-only draft retained after sync and reload');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await fixture.close();
}
