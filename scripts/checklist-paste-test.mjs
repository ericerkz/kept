import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Pasting a list makes one checklist item per line:
// into a checklist row, a list's "List item" row, or a text body (which gets
// a checklist at the caret). Plain text only; the title stays one line.
// Each layout gets its own server and database, so every card is on screen.
for (const mobile of [false, true]) {
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
    browser = await chromium.launch({ headless: true });

    {
      const label = mobile ? 'mobile' : 'desktop';
      const seed = (name, overrides = {}) => api('/notes', 'POST', {
        noteTitle: `${label} ${name}`, noteBody: '', isCbox: false, pinned: false,
        bgColor: '', bgImage: '', checkBoxes: [], images: [], labels: [], archived: false, trashed: false,
        ...overrides
      }, token);
      const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 900 }, hasTouch: mobile, serviceWorkers: 'block' });
      await context.addInitScript(() => {
        localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
        localStorage.setItem('kept_user_preferences', JSON.stringify({ moveCompletedChecklistItemsToBottom: true }));
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => console.error('Browser error:', error));
      await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());
      await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Username', { exact: true }).fill(credentials.username);
      await page.getByLabel('Password', { exact: true }).fill(credentials.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const editor = page.locator('app-input .note-main:visible').last();
      const body = editor.locator('.note-body[contenteditable]:not(.note-body-after)');
      const title = editor.getByRole('textbox', { name: 'Title', exact: true });
      const rows = editor.locator('[data-cbox-id]');
      const draft = editor.locator('[data-checklist-draft]').first();
      const click = locator => mobile ? locator.tap() : locator.click();
      const open = async id => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await click(page.locator(`app-notes .note-container[data-note-id="${id}"] .title`));
        await editor.waitFor();
      };
      const close = async () => {
        if (mobile) await click(editor.locator('.mobile-top-bar .back'));
        else await editor.getByRole('button', { name: 'Close', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
      };
      const saved = async (id, matches) => {
        for (let attempt = 0; attempt < 70; attempt++) {
          const note = await api(`/notes/${id}`, 'GET', undefined, token);
          if (matches(note)) return note;
          await page.waitForTimeout(100);
        }
        assert.fail('note changes must reach the server');
      };
      // Caret at the end of a field, or after its first `offset` characters.
      // Focus first: focusing a row moves its caret to the end on the next tick.
      const caret = (field, offset) => field.evaluate(async (el, offset) => {
        el.focus();
        await new Promise(resolve => setTimeout(resolve, 20));
        const range = document.createRange();
        if (offset === undefined) { range.selectNodeContents(el); range.collapse(false); }
        else { range.setStart(el.firstChild, offset); range.collapse(true); }
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      }, offset);
      const paste = (field, text, html) => field.evaluate((el, { text, html }) => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        if (html) data.setData('text/html', html);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, { text, html });
      const texts = async () => (await rows.allTextContents()).map(text => text.trim());
      const rowSummary = note => note.checkBoxes.map(row => [row.data, !!row.done, row.indentLevel || 0]);

      // A list pasted into a text body becomes a checklist at the caret.
      const bodyNote = await seed('body', { noteBody: '<div>Shopping</div>' });
      await open(bodyNote.id);
      await caret(body);
      await paste(body, '- Milk\r\n- [x] Eggs\r\n  - Free range\r\n\r\n* Bread');
      // "Free range" has no [x], so it stays open while "Eggs" moves to Completed.
      assert.deepEqual(await texts(), ['Milk', 'Free range', 'Bread', 'Eggs'], `${label}: checked items move to Completed`);
      assert.equal(await body.textContent(), 'Shopping');
      await close();
      const bodySaved = await saved(bodyNote.id, note => note.checkBoxes.length === 4);
      assert.equal(bodySaved.isCbox, true);
      assert.deepEqual(rowSummary(bodySaved), [['Milk', false, 0], ['Eggs', true, 0], ['Free range', false, 1], ['Bread', false, 0]]);
      assert.match(bodySaved.noteBody, /Shopping/);

      // Undo on the "Pasted as a checklist" message puts back the text exactly
      // as pasted, in the same place.
      const undoNote = await seed('undo paste', { noteBody: '<div>Before</div>' });
      await open(undoNote.id);
      await caret(body);
      await paste(body, '- Tea\n- Coffee');
      assert.deepEqual(await texts(), ['Tea', 'Coffee']);
      const bar = page.locator('.snackbar-container').last();
      assert.match(await bar.innerText(), /Pasted as a checklist/);
      await click(bar.locator('button.action', { hasText: 'Undo' }));
      assert.equal(await rows.count(), 0);
      assert.match(await body.innerText(), /Before\s+- Tea\s+- Coffee/);
      await close();
      const undoSaved = await saved(undoNote.id, note => !note.isCbox && note.noteBody.includes('- Coffee'));
      assert.deepEqual(undoSaved.checkBoxes, []);
      assert.doesNotMatch(undoSaved.noteBody, /kept-checklist-anchor/);

      // Prose is pasted as text, not turned into a checklist.
      const proseNote = await seed('prose', { noteBody: '<div>Notes</div>' });
      await open(proseNote.id);
      await caret(body);
      await paste(body, 'Call the dentist\nPick up dry cleaning');
      assert.equal(await rows.count(), 0);
      assert.match(await body.innerText(), /Call the dentist\s+Pick up dry cleaning/);
      await close();
      const proseSaved = await saved(proseNote.id, note => note.noteBody.includes('dentist'));
      assert.equal(proseSaved.isCbox, false);

      // Into the "List item" row: one row per line at the end of the list, the
      // checked row is left alone, and web page HTML is never pasted.
      const draftNote = await seed('draft', { isCbox: true, checkBoxes: [
        { id: 0, data: 'Apples', done: false, indentLevel: 0 },
        { id: 1, data: 'Done already', done: true, indentLevel: 0 }
      ] });
      await open(draftNote.id);
      await click(draft);
      await paste(draft, '1. Pears\n2. <b>Plums</b> & co', '<ol><li style="color:red">Pears</li><li><b>Plums</b></li></ol>');
      assert.deepEqual(await texts(), ['Apples', 'Pears', '<b>Plums</b> & co', 'Done already']);
      assert.equal(await draft.textContent(), '');
      const focusedText = await page.evaluate(() => document.activeElement?.textContent);
      assert.equal(focusedText, '<b>Plums</b> & co', 'the caret ends in the last pasted row');
      await close();
      const draftSaved = await saved(draftNote.id, note => note.checkBoxes.length === 4);
      assert.deepEqual(rowSummary(draftSaved), [['Apples', false, 0], ['Done already', true, 0], ['Pears', false, 0],
        ['&lt;b&gt;Plums&lt;/b&gt; &amp; co', false, 0]]);

      // Into an existing row: split at the caret; the text after the caret ends
      // up after the last pasted line. One Undo removes the whole paste.
      const rowNote = await seed('row', { isCbox: true, checkBoxes: [
        { id: 0, data: 'AlphaOmega', done: false, indentLevel: 0 },
        { id: 1, data: 'Next', done: false, indentLevel: 0 }
      ] });
      await open(rowNote.id);
      await caret(rows.first(), 5);
      await paste(rows.first(), 'Beta\nGamma\nDelta');
      assert.deepEqual(await texts(), ['AlphaBeta', 'Gamma', 'DeltaOmega', 'Next']);
      const caretInfo = await page.evaluate(() => {
        const selection = window.getSelection();
        return { text: document.activeElement?.textContent, offset: selection.anchorOffset };
      });
      assert.deepEqual(caretInfo, { text: 'DeltaOmega', offset: 5 }, 'caret after "Delta", before "Omega"');
      await editor.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual(await texts(), ['AlphaOmega', 'Next']);
      await editor.getByRole('button', { name: 'Redo', exact: true }).click();
      assert.deepEqual(await texts(), ['AlphaBeta', 'Gamma', 'DeltaOmega', 'Next']);
      await close();
      await saved(rowNote.id, note => note.checkBoxes.length === 4);

      // One line pasted into a row is inserted like typing, markers removed.
      const oneNote = await seed('one', { isCbox: true, checkBoxes: [{ id: 0, data: 'Buy ', done: false, indentLevel: 0 }] });
      await open(oneNote.id);
      await caret(rows.first());
      await paste(rows.first(), '- oat milk');
      assert.deepEqual(await texts(), ['Buy oat milk']);
      await close();
      await saved(oneNote.id, note => note.checkBoxes[0]?.data === 'Buy oat milk');

      // The title stays on one line.
      const titleNote = await seed('title');
      await open(titleNote.id);
      await title.evaluate(el => { el.innerHTML = ''; });
      await caret(title);
      await paste(title, 'Weekend\n  plans\n');
      assert.equal(await title.innerHTML(), 'Weekend plans');
      await close();
      await saved(titleNote.id, note => note.noteTitle === 'Weekend plans');

      await context.close();
      console.log(`PASS ${label}: list paste into body (with Undo back to text), List item row and rows; prose and title stay text`);
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
