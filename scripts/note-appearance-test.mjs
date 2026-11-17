import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture(); let browser;
try {
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  const api = async (path, method = 'GET', body, token) => {
    const r = await fetch(fixture.origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(r.ok, `${method} ${path}: ${r.status}`); return r.status === 204 ? null : r.json();
  };
  await api('/setup/admin', 'POST', credentials);
  await fixture.sql('UPDATE users SET demoNotesCreatedAt = ?', [new Date().toISOString()]);
  const { token } = await api('/auth/login', 'POST', credentials);
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const base = { noteTitle: `Appearance ${mobile ? 'mobile' : 'desktop'}`, noteBody: '<p>Flying out Thursday the 4th, back late Sunday. Maya has the apartment keys. A long line of text makes the highlight wrap naturally.</p>', bgColor: '#1a4a4a', bgImage: '', pattern: 'travel', labels: [], images: [], checkBoxes: [{ id: 0, data: 'Reserve a table at the tasca by the river', done: false }], isCbox: true, pinned: false, archived: false, trashed: false };
    const note = await api('/notes', 'POST', base, token);
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 980 }, hasTouch: mobile, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
    await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const card = page.locator(`app-notes [data-note-id="${note.id}"]`);
    await card.waitFor();
    assert.match(await card.locator('.note-main').evaluate(el => getComputedStyle(el).backgroundImage), /data:image\/svg\+xml/);
    assert.equal(await card.locator('.note-main').evaluate(el => getComputedStyle(el).backgroundSize), '100px 100px');
    if (!mobile) {
      await card.hover(); await card.locator('.icons-container .color').click();
      const overviewPicker = page.locator('app-notes > .colorMenu[data-is-tooltip-open="true"] app-note-appearance-picker');
      await overviewPicker.getByRole('tab', { name: 'Background', exact: true }).click();
      assert.equal(await overviewPicker.locator('.pattern-choice').count(), 27);
      await overviewPicker.locator('[data-pattern="movies"]').click();
      await overviewPicker.locator('[data-pattern="travel"]').click();
    }
    await card.locator('.title').click();
    const editor = page.locator('app-input .note-main:visible').last();
    const picker = page.locator('app-input .colorMenu[data-is-tooltip-open="true"] app-note-appearance-picker');
    const body = editor.locator('.note-body[contenteditable]:not(.note-body-after)');
    const openAppearance = () => editor.locator(mobile ? '.mobile-bottom-bar .mobile-icon.color' : '.icons .color').click();
    const select = async (field, text) => {
      await field.evaluate(el => el.closest('[contenteditable="true"]')?.focus());
      await page.waitForTimeout(25); // Let the existing checklist focus handler place its initial caret.
      return field.evaluate((el, text) => { const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) { const offset = node.textContent.indexOf(text); if (offset >= 0) {
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + text.length);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range); return;
      }} throw Error('Missing text to select: ' + text);
    }, text);
    };
    await editor.locator(mobile ? '.mobile-bottom-bar .format' : '.text-format-trigger').click();
    await select(body, 'Thursday the 4th');
    const highlight = editor.locator('.highlight-format:visible').first();
    await highlight.click();
    assert.equal(await body.locator('mark.hl').textContent(), 'Thursday the 4th');
    assert.equal(await body.locator('mark.hl').evaluate(el => getComputedStyle(el).color), await body.evaluate(el => getComputedStyle(el).color));
    assert.match(await body.locator('mark.hl').evaluate(el => getComputedStyle(el).backgroundImage), /78deg/);
    assert.equal(await body.locator('mark.hl').evaluate(el => getComputedStyle(el).webkitBoxDecorationBreak), 'clone');
    // Removing only part of a highlight leaves the surrounding text marked.
    await select(body.locator('mark.hl'), 'the'); await highlight.click();
    assert.equal(await body.locator('mark.hl').allTextContents().then(x => x.join('')), 'Thursday  4th');
    await editor.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await body.locator('mark.hl').textContent(), 'Thursday the 4th');
    const longText = 'Maya has the apartment keys. A long line of text makes the highlight wrap naturally.';
    await select(body, longText); await highlight.click();
    const wrapped = body.locator('mark.hl').filter({ hasText: 'Maya has' });
    if (mobile) assert.ok(await wrapped.evaluate(el => el.getClientRects().length) > 1, 'the same marker spans wrapped lines');
    await highlight.click();
    const row = editor.locator('[data-cbox-id="0"]'); await select(row, 'Reserve a table'); await highlight.click();
    assert.equal(await row.locator('mark.hl').textContent(), 'Reserve a table');
    await openAppearance(); await picker.getByRole('tab', { name: 'Background', exact: true }).click();
    assert.equal(await picker.locator('.pattern-choice').count(), 27);
    assert.deepEqual(await picker.locator('.pattern-choice').evaluateAll(items => Object.values(items.reduce((rows, el) => { const y = Math.round(el.getBoundingClientRect().top); rows[y] = (rows[y] || 0) + 1; return rows; }, {}))), [9, 9, 9]);
    await picker.locator('[data-pattern="roses"]').click();
    assert.equal(await picker.locator('[data-pattern="roses"]').getAttribute('aria-pressed'), 'true');
    await picker.locator('[data-pattern="travel"]').click();
    assert.equal(await picker.locator('.background-choice').count(), 13);
    assert.equal(await picker.locator('[data-pattern="travel"]').getAttribute('aria-pressed'), 'true');
    const beforeTint = await picker.locator('[data-pattern="travel"]').evaluate(el => getComputedStyle(el).backgroundImage);
    await picker.getByRole('tab', { name: 'Colour', exact: true }).click(); await picker.locator('[data-bg-color="apricot"]').click();
    const highlightColour = await editor.evaluate(el => getComputedStyle(el).getPropertyValue('--hl').trim());
    assert.equal(highlightColour, '#b9d6ff');
    await picker.getByRole('tab', { name: 'Background', exact: true }).click();
    assert.notEqual(await picker.locator('[data-pattern="travel"]').evaluate(el => getComputedStyle(el).backgroundImage), beforeTint);
    await picker.locator('[data-bg-image="budget"]').click();
    assert.equal(await editor.locator('.has-note-pattern').count(), 0);
    await picker.locator('[data-pattern="garden"]').click();
    assert.equal(await editor.locator('.has-note-pattern').count(), 1);
    await picker.locator('[data-bg-image="zNone"]').click();
    assert.equal(await picker.locator('[data-pattern="garden"]').getAttribute('aria-pressed'), 'true', 'None clears only illustration');
    for (const light of [false, true]) {
      await page.evaluate(light => document.body.classList.toggle('light-theme', light), light);
      await picker.getByRole('tab', { name: 'Colour', exact: true }).click();
      await picker.locator('[data-bg-color="_"]').click();
      await picker.getByRole('tab', { name: 'Background', exact: true }).click();
      assert.equal(await picker.locator('.pattern-choice').evaluateAll(items => items.every(el => el.getBoundingClientRect().right <= innerWidth)), true);
      assert.equal(await picker.locator('.background-choice-label').evaluateAll(items => items.every(el => el.scrollWidth <= el.clientWidth + 1)), true);
      assert.equal(await editor.evaluate(el => getComputedStyle(el).getPropertyValue('--hl').trim()), light ? '#ffe066' : '#896300');
      if (process.env.KEPT_APPEARANCE_SCREENSHOTS) await page.screenshot({ path: `/tmp/kept-appearance-${mobile ? 'mobile' : 'desktop'}-${light ? 'light' : 'dark'}.png` });
    }
    await picker.locator('[data-pattern="garden"]').click();
    assert.equal(await picker.locator('[data-pattern="garden"]').getAttribute('aria-pressed'), 'false', 'selected pattern toggles off');
    await picker.locator('[data-pattern="lemons"]').click();
    if (mobile) await editor.locator('.mobile-top-bar .back').click(); else await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    let stored; for (let i = 0; i < 80; i++) { stored = await api(`/notes/${note.id}`, 'GET', undefined, token); if (stored.pattern === 'lemons' && stored.noteBody.includes('<mark') && stored.checkBoxes[0].data.includes('<mark')) break; await page.waitForTimeout(100); }
    assert.equal(stored.pattern, 'lemons'); assert.equal(stored.bgImage, ''); assert.match(stored.noteBody, /<mark class="hl">Thursday the 4th<\/mark>/);
    assert.match(stored.checkBoxes[0].data, /<mark class="hl">Reserve a table<\/mark>/);
    assert.doesNotMatch(stored.noteBody, /--hl|#[a-f0-9]{6}/i, 'highlight colours are never stored in note content');
    await card.locator('mark.hl').first().waitFor();
    assert.match(await card.locator('mark.hl').first().evaluate(el => getComputedStyle(el).backgroundImage), /78deg/);
    const cards = await api('/notes?view=card', 'GET', undefined, token);
    assert.equal(cards.notes.find(item => item.id === note.id).pattern, 'lemons');
    if (!mobile) {
      const second = await api('/notes', 'POST', { ...base, noteTitle: 'Bulk appearance', pattern: null, isCbox: false, checkBoxes: [] }, token);
      await page.reload({ waitUntil: 'domcontentloaded' }); await card.waitFor();
      const other = page.locator(`app-notes [data-note-id="${second.id}"]`); await other.waitFor();
      await card.hover(); await card.locator(':scope > .check-icon').click();
      await other.locator(':scope > .check-icon').click();
      await page.locator('app-navbar .selection-icon.color').click();
      const bulk = page.locator('app-navbar .colorMenu[data-is-tooltip-open="true"] app-note-appearance-picker');
      await bulk.getByRole('tab', { name: 'Background', exact: true }).click();
      assert.equal(await bulk.locator('.pattern-choice').count(), 27);
      await bulk.locator('[data-pattern="budget"]').click();
      await bulk.getByRole('tab', { name: 'Colour', exact: true }).click();
      await bulk.locator('[data-bg-color="apricot"]').click();
      for (let attempt = 0; attempt < 80; attempt++) {
        const firstNote = await api(`/notes/${note.id}`, 'GET', undefined, token);
        const secondNote = await api(`/notes/${second.id}`, 'GET', undefined, token);
        if (firstNote.pattern === 'budget' && secondNote.pattern === 'budget' && secondNote.bgColor === '#fddcbb') break;
        await page.waitForTimeout(100);
      }
      const check = await api(`/notes/${second.id}`, 'GET', undefined, token);
      assert.equal(check.pattern, 'budget'); assert.equal(check.bgColor, '#fddcbb');
      await page.locator('app-navbar .selection-close').click();
    }
    await card.locator('.title').click(); assert.equal(await body.locator('mark.hl').textContent(), 'Thursday the 4th');
    await context.setOffline(true); await openAppearance(); await picker.getByRole('tab', { name: 'Background', exact: true }).click(); await picker.locator('[data-pattern="music"]').click();
    if (mobile) await editor.locator('.mobile-top-bar .back').click(); else await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.waitFor({ state: 'hidden' }); await card.locator('.title').click(); await openAppearance(); await picker.getByRole('tab', { name: 'Background', exact: true }).click();
    assert.equal(await picker.locator('[data-pattern="music"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS ${mobile ? 'mobile' : 'desktop'}: all picker choices, live tint/highlights, semantic/partial/undo/checklist marks, theme defaults, exclusivity, persistence and offline recovery`);
  }
} finally { await browser?.close(); await fixture.close(); }
