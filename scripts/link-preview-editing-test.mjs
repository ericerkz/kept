import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Exercise real browser caret movement, paste and saves.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
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
  const url = 'https://example.com/test';
  const create = noteBody => api('/notes', { noteTitle: 'Link editing', noteBody, labels: [], images: [], checkBoxes: [] });
  const note = await create(url);
  const untouched = [];
  for (const html of [url, `<p><b><a href="${url}">A linked label</a></b></p>`, `${url}<br>https://example.com/second`]) {
    const item = await create(html);
    untouched.push({ ...item, original: (await api(`/notes/${item.id}`)).noteBody });
  }
  const pasted = await create('Before ');
  const plain = await create('Plain ');
  browser = await (process.env.KEPT_TEST_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
  const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
  const login = await context.request.post(fixture.origin + '/api/auth/browser/login', {
    data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
  });
  assert.ok(login.ok());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(url => url.pathname.endsWith('/link-preview'), route => route.fulfill({ json: { title: 'Example', domain: 'example.com' } }));
  await page.route(/https:\/\//, route => route.abort());
  const body = page.locator('app-notes .modal app-input .note-body[contenteditable]');
  const editor = page.locator('app-notes .modal app-input');
  const open = async id => {
    if (page.url() === 'about:blank') await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.locator(`app-notes .note-container[data-note-id="${id}"] .title`).click();
    await body.waitFor();
  };
  const close = async () => {
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
  };
  const caret = async (target, end = false) => target.evaluate((el, end) => {
    el.closest('[contenteditable="true"]').focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(!end);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, end);
  const paste = text => body.evaluate((el, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);

  // A saved preview at either edge has editable lines; arrow keys cross it.
  await open(note.id);
  assert.equal(await body.locator('.editor-link-caret-line').count(), 2);
  await caret(body.locator('.editor-link-caret-line').first());
  await page.keyboard.type('Above');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('Below');
  assert.equal(await body.locator('.editor-link-caret-line').last().innerText(), 'Below');
  await page.keyboard.press('ArrowUp');
  assert.ok(await body.locator('.editor-link-caret-line').first().evaluate(el => el.contains(getSelection().anchorNode)));
  await caret(body.locator('.editor-link-caret-line').first());
  await page.keyboard.type('Top ');
  assert.match(await body.locator('.editor-link-caret-line').first().innerText(), /Top Above/);
  await close();
  let saved = (await api(`/notes/${note.id}`)).noteBody;
  assert.match(saved, /Top Above<br\s*\/?>https:\/\/example\.com\/test<br\s*\/?>Below/);
  assert.doesNotMatch(saved, /editor-link-/);
  await open(note.id);
  await close();
  assert.equal((await api(`/notes/${note.id}`)).noteBody, saved, 'reopening does not add blank lines');
  console.log('PASS: typing above/below a reopened preview, arrow navigation and save/reopen');

  // Empty cursor targets never become saved content, including nested links.
  for (const item of untouched) {
    for (let i = 0; i < 2; i++) {
      await open(item.id);
      await body.locator('.editor-link-preview-slot').first().waitFor();
      await close();
      assert.equal((await api(`/notes/${item.id}`)).noteBody, item.original);
    }
  }
  console.log('PASS: preview-only, formatted and multiple-link notes do not accumulate saved placeholders');

  // Pasting converts only new links and keeps the caret after the pasted URL.
  await open(pasted.id);
  await caret(body, true);
  await paste(url);
  await body.locator('.editor-link-preview-slot').waitFor();
  await page.keyboard.type('After');
  assert.equal(await body.locator('.editor-link-caret-line').last().innerText(), 'After');
  await caret(body.locator('.editor-link-caret-line').last(), true);
  await paste(' https://example.com/second');
  await page.waitForFunction(() => document.querySelectorAll('.modal .editor-link-preview-slot').length === 2);
  await body.locator('.editor-link-preview-card').nth(1).waitFor();
  assert.equal(await body.locator('.editor-link-preview-card').count(), 2, 'existing preview cards remain hydrated');
  await close();
  saved = (await api(`/notes/${pasted.id}`)).noteBody;
  assert.ok(saved.includes(url));
  assert.ok(saved.includes('After'));
  assert.ok(saved.includes('https://example.com/second'));
  assert.doesNotMatch(saved, /editor-link-|contenteditable/);
  console.log('PASS: paste retains the caret, existing cards and entered text');

  // #112: even plain text used to rebuild the body and reset the caret.
  for (const mobile of [false, true]) {
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 900 });
    const placeholder = page.getByPlaceholder('Take a note…').first();
    if (await placeholder.isVisible()) await placeholder.click();
    else await page.getByRole('button', { name: 'New note', exact: true }).click();
    const composer = page.locator('app-input .note-main:visible').first();
    const field = composer.locator('.note-body[contenteditable]');
    await composer.getByRole('textbox', { name: 'Title', exact: true }).fill(`Plain paste ${mobile ? 'phone' : 'desktop'}`);
    const cases = [
      { initial: 'Before ', start: 7, end: 7, text: 'asdf', expected: 'Before asdf!' },
      { initial: 'Before after', start: 7, end: 7, text: 'asdf ', expected: 'Before asdf !after' },
      { initial: 'After', start: 0, end: 0, text: 'asdf ', expected: 'asdf !After' },
      { initial: 'Before old after', start: 7, end: 10, text: 'asdf', expected: 'Before asdf! after' },
      { initial: 'Before after', start: 7, end: 7, text: 'first\nsecond', expected: 'Before first\nsecond!after' }
    ];
    for (const sample of cases) {
      await field.fill(sample.initial);
      await field.evaluate((el, sample) => {
        el.focus();
        const point = offset => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.length && offset <= node.length) return [node, offset];
            offset -= node.length;
          }
          return [el, el.childNodes.length];
        };
        const range = document.createRange();
        range.setStart(...point(sample.start));
        range.setEnd(...point(sample.end));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', sample.text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, sample);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.keyboard.type('!');
      assert.equal(await field.innerText(), sample.expected, `plain paste at ${sample.start} on ${mobile ? 'phone' : 'desktop'}`);
    }
    await composer.locator('.close-btn:visible,.mobile-icon.back:visible').first().click();
    await field.waitFor({ state: 'hidden' });
    console.log(`PASS: #112 ${mobile ? 'phone' : 'desktop'} new-note paste at beginning/middle/end, selection replacement and multiline text`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.evaluate(() => localStorage.setItem('kept_user_preferences', JSON.stringify({ richLinkPreviews: false })));
  await page.waitForLoadState('networkidle');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await open(plain.id);
  await caret(body, true);
  await paste(url);
  // Let the queued decoration frame run before inspecting the result.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await body.locator('.editor-link-preview-slot').count(), 0);
  assert.equal(await body.textContent(), 'Plain ' + url);
  await close();
  assert.deepEqual(errors, []);
  console.log('PASS: disabled previews keep plain text; no browser errors');
  await context.close();
} finally {
  await browser?.close();
  await fixture.close();
}
