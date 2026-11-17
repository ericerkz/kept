import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Both desktop keydown and mobile beforeinput paths
// exercise real rendered editors and persistent local-first/server saves.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  const api = async (path, method = 'GET', body, token) => {
    const response = await fetch(fixture.origin + '/api' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  await api('/setup/admin', 'POST', credentials);
  await fixture.sql('UPDATE users SET demoNotesCreatedAt = ?', [new Date().toISOString()]);
  const { token } = await api('/auth/login', 'POST', credentials);
  const richBody = '<div><b>Keep this text</b></div><div><i>And this formatting</i></div>';
  const pixel = { name: 'pixel.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mJ8AAAAASUVORK5CYII=', 'base64') };
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    const seed = (name, overrides = {}) => api('/notes', 'POST', {
      noteTitle: `${label} ${name}`, noteBody: richBody, isCbox: false, pinned: false,
      bgColor: '', bgImage: '', checkBoxes: [], images: [], labels: [], archived: false, trashed: false,
      ...overrides
    }, token);
    const plain = await seed('plain');
    const checklist = await seed('checklist', { noteBody: '', isCbox: true, checkBoxes: [
      { id: 0, data: '<b>Parent</b>', done: false, indentLevel: 0 },
      { id: 1, data: '<i>Child</i>', done: false, indentLevel: 1 },
      { id: 2, data: 'Completed row', done: true, indentLevel: 0 }
    ] });
    const placement = await seed('placement', { noteBody: '<div>Text before <b>bold</b></div><div>Text after <i>italic</i></div>' });
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 900 }, hasTouch: mobile, serviceWorkers: 'block' });
    await context.addInitScript(mobile => {
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
      localStorage.setItem('kept_user_preferences', JSON.stringify({ moveCompletedChecklistItemsToBottom: !mobile }));
    }, mobile);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => console.error('Browser error:', error));
    await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());
    await page.route('**/api/link-preview?*', route => route.fulfill({ json: { title: 'Example link', domain: 'example.com' } }));
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const editor = page.locator('app-input .note-main:visible').last();
    const body = editor.locator('.note-body[contenteditable]:not(.note-body-after)');
    const afterBody = editor.locator('.note-body-after');
    const rows = editor.locator('[data-cbox-id]');
    const checkboxButton = editor.locator(mobile ? '.mobile-bottom-bar .checklist-action' : '.icons .checklist-action');
    const click = locator => mobile ? locator.tap() : locator.click();
    const open = async id => { await click(page.locator(`app-notes .note-container[data-note-id="${id}"] .title`)); await editor.waitFor(); };
    const close = async () => {
      if (mobile) await click(editor.locator('.mobile-top-bar .back'));
      else await editor.getByRole('button', { name: 'Close', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
    };
    const caret = (field, where) => field.evaluate((el, where) => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (where === 'middle') range.setStartAfter(el.firstElementChild);
      range.collapse(where === 'start' || where === 'middle');
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    }, where);
    const enter = async field => {
      if (mobile) await field.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertParagraph', bubbles: true, cancelable: true
      })));
      else await field.press('Enter');
    };
    const history = command => editor.getByRole('button', { name: command, exact: true }).click();
    const saved = async (id, matches) => {
      for (let attempt = 0; attempt < 70; attempt++) {
        const note = await api(`/notes/${id}`, 'GET', undefined, token);
        if (matches(note)) return note;
        await page.waitForTimeout(100);
      }
      assert.fail('note changes must reach the server');
    };

    // #141: adding then leaving an empty checklist cannot clear existing text.
    await open(plain.id);
    assert.equal(await checkboxButton.isVisible(), true);
    for (let n = 0; n < 3; n++) {
      await caret(body, 'end');
      await click(checkboxButton);
      assert.equal(await rows.count(), 1);
      assert.equal(await body.locator('b').textContent(), 'Keep this text');
      await enter(rows.last());
      assert.equal(await rows.count(), 0);
      assert.equal(await body.locator('i').textContent(), 'And this formatting');
      assert.equal(await body.evaluate(el => document.activeElement === el), true);
    }
    await history('Undo');
    assert.equal(await rows.count(), 1);
    await history('Redo');
    assert.equal(await rows.count(), 0);
    await click(editor.locator(mobile ? '.mobile-icon.more' : '.icons .more'));
    const menu = page.locator('.moreMenu[data-is-tooltip-open="true"]');
    assert.equal(await menu.getByText(/^(Show checkboxes|Hide checkboxes|Add text|Add text below checklist|Move checklist here)$/).count(), 0);
    await click(editor.getByRole('textbox', { name: 'Title', exact: true }));
    await close();
    await saved(plain.id, note => !note.isCbox && note.checkBoxes.length === 0);
    await open(plain.id);
    assert.equal(await body.locator('b').textContent(), 'Keep this text');
    await close();

    // Empty space above/below the checklist opens ordinary text in that spot.
    await open(checklist.id);
    if (mobile) await editor.evaluate(el => el.closest('app-input').classList.add('native-phone-layout'));
    const oldTop = (await rows.first().boundingBox()).y;
    await click(editor.locator('.checklist-text-before'));
    assert.equal(await body.evaluate(el => document.activeElement === el), true);
    await page.keyboard.type('Introduction');
    assert.ok((await rows.first().boundingBox()).y > oldTop, 'adding text above must push the checklist down');
    if (mobile) {
      assert.ok((await body.boundingBox()).height < 100, 'mobile text above a checklist must not reserve a whole screen');
      const containerBox = await editor.locator('.note-container').boundingBox();
      const belowBox = await editor.locator('.checklist-text-after').boundingBox();
      const y = (belowBox.y + belowBox.height + containerBox.y + containerBox.height) / 2;
      await page.touchscreen.tap(containerBox.x + containerBox.width / 2, y);
    } else await click(editor.locator('.checklist-text-after'));
    assert.equal(await afterBody.evaluate(el => document.activeElement === el), true);
    await page.keyboard.type('Existing ending');

    // Enter adds a row; Enter on that empty final row exits into trailing text.
    const lastRow = mobile ? rows.last() : rows.nth(1);
    await caret(lastRow, 'end');
    const previousCount = await rows.count();
    await enter(lastRow);
    const empty = editor.locator('[data-cbox-id="3"]');
    assert.equal(await empty.textContent(), '');
    assert.equal(await rows.count(), previousCount + 1);
    if (mobile) {
      await empty.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertParagraph', isComposing: true, bubbles: true, cancelable: true
      })));
      assert.equal(await rows.count(), previousCount + 1, 'composition must not exit the checklist');
      await empty.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertLineBreak', bubbles: true, cancelable: true
      })));
    } else await enter(empty);
    assert.equal(await rows.count(), previousCount);
    assert.equal(await afterBody.evaluate(el => document.activeElement === el), true);
    await page.keyboard.type('New paragraph. ');
    assert.ok((await afterBody.textContent()).endsWith('Existing ending'));
    assert.equal(await rows.first().locator('b').textContent(), 'Parent');
    await history('Undo'); // Undo typing first, not the structural exit.
    assert.equal(await rows.count(), previousCount);
    await close();
    const checklistSaved = await saved(checklist.id, note => note.noteBody.includes('Introduction') && note.noteBody.includes('Existing ending'));
    assert.equal(checklistSaved.checkBoxes.length, 3);
    assert.equal(checklistSaved.checkBoxes[1].indentLevel, 1);
    assert.equal(checklistSaved.checkBoxes[2].done, true);
    await open(checklist.id);
    assert.equal(await body.textContent(), 'Introduction');
    assert.ok((await afterBody.textContent()).includes('Existing ending'));
    await close();

    // Separate checklists keep their own rows and all the surrounding text.
    await open(placement.id);
    await caret(body, 'middle');
    await click(checkboxButton);
    await rows.first().fill('Only checklist item');
    assert.equal(await body.locator('b').textContent(), 'bold');
    assert.equal(await afterBody.locator('i').textContent(), 'italic');
    await close();
    await saved(placement.id, note => note.isCbox && note.checkBoxes[0]?.data === 'Only checklist item');
    const card = page.locator(`app-notes .note-container[data-note-id="${placement.id}"]`);
    const displayed = await card.locator('.body-segments > .body, .body-segments > .cboxes').allTextContents();
    assert.ok(displayed[0].includes('Text before'));
    assert.ok(displayed[1].includes('Only checklist item'));
    assert.ok(displayed[2].includes('Text after'));
    const cardData = (await api('/notes?view=card', 'GET', undefined, token)).notes.find(note => note.id === placement.id);
    assert.match(cardData.noteBody, /kept-checklist-anchor/);
    await open(placement.id);
    await caret(afterBody.first(), 'end');
    await click(checkboxButton);
    assert.equal(await editor.locator('[data-checklist-id]').count(), 2);
    assert.equal(await rows.count(), 2);
    await rows.last().fill('Second checklist item');
    await caret(rows.last(), 'start');
    await rows.last().press('Backspace');
    assert.equal(await rows.count(), 2, 'Backspace must not join separate lists across text');
    assert.equal(await rows.first().textContent(), 'Only checklist item');
    // Undo inserting a new block, before editing it, also restores text.
    await click(editor.locator('.checklist-text-after').last());
    await caret(afterBody.last(), 'end');
    await click(checkboxButton);
    assert.equal(await editor.locator('[data-checklist-id]').count(), 3);
    await history('Undo');
    assert.equal(await editor.locator('[data-checklist-id]').count(), 2);
    await history('Redo');
    assert.equal(await editor.locator('[data-checklist-id]').count(), 3);
    await rows.last().fill('Third checklist item');
    await caret(rows.last(), 'end');
    await enter(rows.last());
    assert.equal(await rows.count(), 4);
    await enter(rows.last());
    assert.equal(await rows.count(), 3, 'leaving the third list must keep both earlier lists');
    assert.equal(await afterBody.last().evaluate(el => document.activeElement === el), true);
    assert.equal(await editor.locator('.note-body.ph:visible').count(), 0, 'click-to-add/exit must never redisplay Take a note');
    await page.keyboard.type('Tail ');
    const lists = editor.locator('[data-checklist-id]');
    await caret(lists.nth(1).locator('[data-cbox-id]').first(), 'end');
    await lists.nth(1).locator('[data-cbox-id]').first().press('Tab');
    await click(lists.first().locator('.cbox-icon').first());
    assert.equal(await lists.nth(1).locator('.cbox-icon.done').count(), 0, 'checking an item must not affect another list');
    assert.equal(await lists.nth(2).locator('.cbox-icon.done').count(), 0);
    await click(lists.first().locator('.cbox-icon').first());
    if (!mobile) {
      for (let index = 0; index < 3; index++) await click(lists.nth(index).locator('.cbox-icon').first());
      await click(lists.first().locator('.completed-items-header'));
      assert.equal(await lists.first().locator('[data-cbox-id]').count(), 0);
      assert.equal(await lists.nth(1).locator('[data-cbox-id]').count(), 1, 'completed sections collapse independently');
      await click(lists.first().locator('.completed-items-header'));
      for (let index = 0; index < 3; index++) await click(lists.nth(index).locator('.cbox-icon').first());
    }
    // Insertion between lists leaves the old lists in place.
    const ending = afterBody.last();
    await caret(ending, 'end');
    await ending.evaluate(el => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', '\nhttps://example.com/after-checklist');
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await afterBody.last().locator('.editor-link-preview-slot').waitFor();
    await editor.locator('..').locator('input.image-input').setInputFiles(pixel);
    await afterBody.last().locator('img.inline-note-image').waitFor();
    await context.setOffline(true);
    await caret(afterBody.last(), 'end'); await page.keyboard.type(' Offline ending');
    await close();
    await open(placement.id);
    assert.ok((await afterBody.last().textContent()).includes('Offline ending'));
    assert.equal(await afterBody.last().locator('img.inline-note-image').count(), 1);
    await close();
    await context.setOffline(false);
    const recovered = await saved(placement.id, note => note.noteBody.includes('Offline ending'));
    assert.equal(recovered.checkBoxes.length, 3);
    assert.equal(new Set(recovered.checkBoxes.map(row => row.listId)).size, 3);
    assert.equal(new Set(recovered.checkBoxes.map(row => row.id)).size, 3);
    assert.equal(recovered.checkBoxes[1].indentLevel, 0, 'the first row of a list cannot indent under another list');
    assert.match(recovered.noteBody, /Text before/);
    assert.match(recovered.noteBody, /Text after/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await open(placement.id);
    assert.equal(await rows.count(), 3);
    assert.ok((await afterBody.last().textContent()).includes('Offline ending'));
    await close();

    // The original data-loss sequence also has to work in a new composer.
    if (mobile) await click(page.locator('.mobile-compose-fab'));
    else await page.locator('app-input .placeholder:visible input').click();
    if (!mobile) {
      const iconBox = await checkboxButton.boundingBox();
      const closeBox = await editor.getByRole('button', { name: 'Close', exact: true }).boundingBox();
      assert.ok(Math.abs(iconBox.y + iconBox.height / 2 - closeBox.y - closeBox.height / 2) < 2,
        `the desktop composer must keep its checkbox button and Close on the same row: ${JSON.stringify({ iconBox, closeBox })}`);
    }
    await editor.getByRole('textbox', { name: 'Title', exact: true }).fill(`${label} new mode note`);
    await body.fill('New note text must survive');
    await click(checkboxButton); await enter(rows.last());
    await close();
    let created;
    for (let n = 0; n < 70 && !created; n++) {
      created = (await api('/notes', 'GET', undefined, token)).find(note => note.noteTitle === `${label} new mode note`);
      if (!created) await page.waitForTimeout(100);
    }
    assert.ok(created);
    assert.match((await api(`/notes/${created.id}`, 'GET', undefined, token)).noteBody, /New note text must survive/);
    if (mobile) {
      await click(page.locator('.mobile-compose-fab'));
      await click(checkboxButton);
      await enter(rows.last());
      await close(); // An empty text line left by exiting a list must not trap Back.
    }
    if (!mobile) {
      await page.goto(fixture.origin + '/settings', { waitUntil: 'domcontentloaded' });
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: /Markdown/ }).click();
      const download = await downloadPromise;
      const chunks = [];
      for await (const chunk of await download.createReadStream()) chunks.push(chunk);
      const zip = await JSZip.loadAsync(Buffer.concat(chunks));
      const file = Object.values(zip.files).find(file => file.name.endsWith('desktop placement.md'));
      assert.ok(file, 'the Markdown export includes the multi-checklist note');
      const markdown = await file.async('string');
      let previous = -1;
      for (const text of ['Text before', 'Only checklist item', 'Text after', 'Second checklist item', 'Third checklist item', 'Offline ending']) {
        const index = markdown.indexOf(text);
        assert.ok(index > previous, `Markdown preserves the position of ${text}`);
        previous = index;
      }
      assert.doesNotMatch(markdown, /kept-checklist-anchor/);
    }
    console.log(`PASS ${label}: toolbar insertion, tap above/below, double Enter, IME safety, multiple-list placement and boundary safety, Undo/Redo, rich content, offline/recovery, autosave and reopen`);
    await context.close();
  }
} finally {
  await browser?.close();
  await fixture.close();
}
