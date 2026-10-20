import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Mobile beforeinput and touch events are simulated;
// desktop Enter and drag tests use browser keyboard/mouse input.
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
  const row = (data, id, indentLevel = 0, done = false) => ({ data, id, indentLevel, done });
  const cases = [
    { name: 'start', rows: [row('Alpha', 0), row('Beta', 1)], index: 0, start: 0, expected: ['', 'Alpha', 'Beta'] },
    { name: 'middle', rows: [row('<b>Alpha bravo</b> tail', 0)], index: 0, start: 6, expected: ['Alpha ', 'bravo tail'], format: true },
    { name: 'end', rows: [row('Alpha', 0), row('Beta', 1), row('Gamma', 2)], index: 1, start: 4, expected: ['Alpha', 'Beta', '', 'Gamma'] },
    { name: 'selection', rows: [row('Alpha bravo', 0)], index: 0, start: 2, end: 8, expected: ['Al', 'avo'] },
    { name: 'nested', rows: [row('Parent', 0), row('Child row', 1, 1), row('Grandchild', 2, 2)], index: 1, start: 4, expected: ['Parent', 'Chil', 'd row', 'Grandchild'], indents: [0, 1, 1, 2] },
    { name: 'completed', rows: [row('Alpha', 0), row('Done row', 1, 0, true)], index: 1, start: 4, expected: ['Alpha', 'Done', ' row'], completed: true },
    { name: 'empty', rows: [row('', 0)], index: 0, start: 0, expected: ['', ''] }
  ];
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    const seeded = [];
    for (const test of [...cases,
      { name: 'join', rows: [row('<b>Alpha</b>', 0), row('<i>Beta</i> tail', 1, 1), row('Child', 2, 2), row('Last', 3)] },
      { name: 'keyboard', rows: [row('First row', 0), row('', 1), row('Wrapped checklist text '.repeat(20), 2), row('Last row', 3)] },
      { name: 'drag', rows: [row('Parent', 0), row('Movable', 1), row('Last', 2)] }
    ]) {
      const note = await api('/notes', 'POST', {
        noteTitle: `${label} ${test.name}`, noteBody: '', isCbox: true, pinned: false,
        bgColor: '', bgImage: '', checkBoxes: test.rows, images: [], labels: [], archived: false, trashed: false
      }, token);
      seeded.push({ ...test, id: note.id });
    }
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 900 }, hasTouch: mobile, serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => console.error('Browser error:', error));
    await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const editor = page.locator('app-input .note-main:visible').last();
    const fields = editor.locator('[data-cbox-id]');
    const open = id => page.locator(`app-notes .note-container[data-note-id="${id}"] .title`).click();
    const close = async () => {
      if (mobile) await editor.locator('.mobile-top-bar .back').click();
      else await editor.getByRole('button', { name: 'Close', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
    };
    const setCaret = (field, start, end) => field.evaluate(async (el, { start, end }) => {
        el.focus();
        await new Promise(resolve => setTimeout(resolve, 0));
        const point = offset => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let text;
          while ((text = walker.nextNode())) {
            if (offset <= text.textContent.length) return [text, offset];
            offset -= text.textContent.length;
          }
          return [el, el.childNodes.length];
        };
        const range = document.createRange();
        range.setStart(...point(start));
        range.setEnd(...point(end ?? start));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }, { start, end });
    const caretState = () => page.evaluate(() => {
      const el = document.activeElement;
      const selection = window.getSelection();
      const prefix = document.createRange();
      prefix.selectNodeContents(el);
      prefix.setEnd(selection.anchorNode, selection.anchorOffset);
      return { id: Number(el.dataset.cboxId), prefix: prefix.toString() };
    });
    const backspace = async field => {
      if (mobile) await field.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward', bubbles: true, cancelable: true
      })));
      else await page.keyboard.press('Backspace');
    };
    for (const test of seeded.filter(test => cases.some(original => original.name === test.name))) {
      await open(test.id);
      await setCaret(fields.nth(test.index), test.start, test.end);
      if (mobile) {
        await fields.nth(test.index).evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertParagraph', bubbles: true, cancelable: true
        })));
      } else await page.keyboard.press('Enter');
      assert.deepEqual(await fields.allTextContents(), test.expected, `${label} ${test.name}`);
      const focus = await fields.nth(test.index + 1).evaluate(el => {
        const selection = window.getSelection();
        const prefix = document.createRange();
        prefix.selectNodeContents(el);
        prefix.setEnd(selection.anchorNode, selection.anchorOffset);
        return { focused: document.activeElement === el, prefix: prefix.toString() };
      });
      assert.deepEqual(focus, { focused: true, prefix: '' }, 'caret must start in the second split row');
      if (test.format) {
        assert.equal(await fields.nth(0).locator('b').textContent(), 'Alpha ');
        assert.equal(await fields.nth(1).locator('b').textContent(), 'bravo');
        await editor.getByRole('button', { name: 'Undo', exact: true }).click();
        assert.deepEqual(await fields.allTextContents(), ['Alpha bravo tail']);
        await editor.getByRole('button', { name: 'Redo', exact: true }).click();
        assert.deepEqual(await fields.allTextContents(), test.expected);
      }
      await close();
      const saved = await api(`/notes/${test.id}`, 'GET', undefined, token);
      assert.equal(saved.checkBoxes.length, test.expected.length);
      const savedText = await page.evaluate(boxes => boxes.map(cb => {
        const el = document.createElement('div');
        el.innerHTML = cb.data;
        return el.textContent;
      }), saved.checkBoxes);
      assert.deepEqual(savedText, test.expected, 'split content must persist');
      assert.equal(new Set(saved.checkBoxes.map(cb => cb.id)).size, saved.checkBoxes.length);
      if (test.indents) assert.deepEqual(saved.checkBoxes.map(cb => cb.indentLevel), test.indents);
      if (test.completed) assert.deepEqual(saved.checkBoxes.map(cb => cb.done), [false, true, true]);
    }

    const join = seeded.find(test => test.name === 'join');
    await open(join.id);
    await setCaret(fields.nth(1), 0);
    await backspace(fields.nth(1));
    assert.deepEqual(await fields.allTextContents(), ['AlphaBeta tail', 'Child', 'Last'], 'Backspace must join text without losing children');
    await page.waitForTimeout(0); // The focus handler must preserve the join position too.
    assert.deepEqual(await caretState(), { id: 0, prefix: 'Alpha' });
    assert.equal(await fields.nth(0).locator('b').textContent(), 'Alpha');
    assert.equal(await fields.nth(0).locator('i').textContent(), 'Beta');
    await editor.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.deepEqual(await fields.allTextContents(), ['Alpha', 'Beta tail', 'Child', 'Last']);
    await editor.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.deepEqual(await fields.allTextContents(), ['AlphaBeta tail', 'Child', 'Last']);
    await setCaret(fields.nth(0), 0);
    await backspace(fields.nth(0));
    assert.equal(await fields.nth(0).textContent(), 'AlphaBeta tail', 'first row must retain its text');
    // Offset zero in the italic node is not the beginning of the row.
    await setCaret(fields.nth(0), 5);
    await fields.nth(0).locator('i').evaluate(el => {
      window.getSelection().collapse(el.firstChild, 0);
    });
    await page.keyboard.press('Backspace');
    assert.deepEqual(await fields.allTextContents(), ['AlphBeta tail', 'Child', 'Last']);
    await setCaret(fields.nth(0), 4, 8);
    await page.keyboard.press('Backspace');
    assert.deepEqual(await fields.allTextContents(), ['Alph tail', 'Child', 'Last'], 'selected text uses normal deletion');
    await close();
    const joined = await api(`/notes/${join.id}`, 'GET', undefined, token);
    assert.deepEqual(joined.checkBoxes.map(cb => cb.id), [0, 2, 3]);
    assert.deepEqual(joined.checkBoxes.map(cb => cb.indentLevel), [0, 2, 0]);
    assert.match(joined.checkBoxes[0].data, /Alph/);

    const keyboard = seeded.find(test => test.name === 'keyboard');
    await open(keyboard.id);
    await setCaret(fields.nth(0), 3);
    await page.keyboard.press('ArrowDown');
    assert.equal((await caretState()).id, 1, 'Down reaches an empty row');
    await page.keyboard.press('ArrowDown');
    assert.equal((await caretState()).id, 2, 'Down reaches the next row');
    await page.keyboard.press('ArrowDown');
    assert.equal((await caretState()).id, 2, 'Down moves within wrapped text first');
    await setCaret(fields.nth(2), (await fields.nth(2).textContent()).length);
    await page.keyboard.press('ArrowDown');
    assert.equal((await caretState()).id, 3, 'Down leaves the final wrapped line');
    await setCaret(fields.nth(3), 2);
    await page.keyboard.press('ArrowUp');
    assert.equal((await caretState()).id, 2, 'Up reaches the previous row');
    await page.keyboard.press('ArrowUp');
    assert.equal((await caretState()).id, 2, 'Up moves within wrapped text first');
    await setCaret(fields.nth(2), 0);
    await page.keyboard.press('ArrowUp');
    assert.equal((await caretState()).id, 1);
    await page.keyboard.press('ArrowUp');
    assert.equal((await caretState()).id, 0);
    await setCaret(fields.nth(1), 0);
    await backspace(fields.nth(1));
    assert.equal(await fields.count(), 3, 'Backspace can join an empty row');
    assert.equal(await fields.nth(0).textContent(), 'First row');
    assert.equal(await fields.nth(0).locator('br').count(), 0, 'empty row adds no line break');
    await close();
    assert.equal((await api(`/notes/${keyboard.id}`, 'GET', undefined, token)).checkBoxes.length, 3);

    const drag = seeded.find(test => test.name === 'drag');
    await open(drag.id);
    const handle = editor.locator('[data-cbox-row-id="1"] .cbox-move-icon');
    const indent = () => handle.evaluate(el => parseFloat(el.style.marginLeft));
    const move = async dx => {
      await handle.hover(); // Wait for the modal's opening animation to settle.
      const rect = await handle.boundingBox();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      if (mobile) {
        await handle.evaluate((target, { x, y }) => {
          const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y });
          target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch] }));
        }, { x, y });
        await page.waitForTimeout(260);
        await handle.evaluate((target, { x, y }) => {
          const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y });
          target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [touch] }));
          target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] }));
        }, { x: x + dx, y });
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForFunction(() => document.querySelector('app-input .note-main:not([hidden]) [data-cbox-row-id="1"]')?.draggable === true);
        await page.mouse.move(x + Math.sign(dx) * 10, y, { steps: 3 });
        await page.mouse.move(x + dx, y, { steps: 6 });
        await page.mouse.move(x + dx, y);
        await page.mouse.up();
      }
    };
    await move(60);
    assert.equal(await indent(), 32, 'dragging right must indent');
    await move(-60);
    assert.equal(await indent(), 0, 'dragging left must outdent');
    assert.deepEqual(await fields.allTextContents(), ['Parent', 'Movable', 'Last'], 'horizontal dragging must preserve row order');
    await close();
    assert.deepEqual((await api(`/notes/${drag.id}`, 'GET', undefined, token)).checkBoxes.map(cb => cb.indentLevel), [0, 0, 0]);
    console.log(`PASS ${label}: Enter, Backspace joins, first-row/selection safety, arrow navigation including wrapped/empty rows, formatting, nesting, caret, undo/redo, drag, saved data`);
    await context.close();
  }
} finally {
  await browser?.close();
  await fixture.close();
}
