import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Exercise real browser caret movement, paste and saves.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  let token;
  async function api(path, data, method = data ? 'POST' : 'GET', bearer = token) {
    const response = await fetch(fixture.origin + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: data ? JSON.stringify(data) : undefined
    });
    assert.ok(response.ok, await response.clone().text());
    return response.status === 204 ? undefined : response.json();
  }
  await api('/setup/admin', credentials);
  token = (await api('/auth/login', credentials)).token;
  await api('/users/me/mark-demo-notes-created', {});
  const url = 'https://example.com/test';
  const create = noteBody => api('/notes', { noteTitle: 'Link editing', noteBody, labels: [], images: [], checkBoxes: [] });
  const note = await create(url);
  const untouched = [];
  for (const html of [url, `<p><b><a href="${url}">A linked label</a></b></p>`, `${url}<br>https://example.com/second`,
    `<a href="${url}">First</a><a href="https://example.com/second">Second</a>`]) {
    const item = await create(html);
    untouched.push({ ...item, original: (await api(`/notes/${item.id}`)).noteBody });
  }
  const pasted = await create('Before ');
  const adjacentUrls = Array.from({ length: 5 }, (_, index) => `https://example.com/adjacent-${index + 1}`);
  const adjacent = await create(adjacentUrls[0]);
  const joinedBody = adjacentUrls.slice(1, 4).join('');
  const joined = await create(`${url}<br>${joinedBody}<br>${adjacentUrls[4]}`);
  const joinedOnly = await api('/notes', { noteTitle: '', noteBody: joinedBody, labels: [], images: [], checkBoxes: [] });
  const redirectUrl = 'https://example.com/redirect?next=https://example.org/destination';
  const redirect = await create(redirectUrl);
  const collaborator = await api('/users', { username: 'collaborator', password: credentials.password });
  const collaboratorToken = (await api('/auth/login', { username: 'collaborator', password: credentials.password })).token;
  const live = await create(url);
  await api(`/notes/${live.id}/collaborators`, { userIds: [collaborator.id] }, 'PUT');
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

  // #136: cards look like separate lines even when pasted without Enter.
  // Removing empty caret targets must not join their underlying URLs on save.
  await open(adjacent.id);
  for (let index = 1; index < adjacentUrls.length; index++) {
    await caret(body, true);
    await paste(adjacentUrls[index]);
    await page.waitForFunction(count => document.querySelectorAll('.modal .editor-link-preview-card').length === count, index + 1);
  }
  await close();
  saved = (await api(`/notes/${adjacent.id}`)).noteBody;
  assert.deepEqual(saved.replace(/<br\s*\/?>/gi, '\n').trim().split(/\s+/), adjacentUrls,
    'visually separate cards must remain separate saved URLs');
  await open(adjacent.id);
  assert.equal(await body.locator('.editor-link-preview-card').count(), 5, 'all five cards return after reopening');
  await close();
  assert.equal((await api(`/notes/${adjacent.id}`)).noteBody, saved, 'reopening must not accumulate separators');
  console.log('PASS: adjacent preview cards retain separate URLs through autosave and close/reopen');

  // Already-joined strings have no trustworthy boundary metadata. Display
  // their complete text instead of concealing later URLs inside one preview.
  for (const item of [joined, joinedOnly]) {
    const original = (await api(`/notes/${item.id}`)).noteBody;
    const overview = page.locator(`app-notes .note-container[data-note-id="${item.id}"]`);
    assert.ok((await overview.innerText()).includes(joinedBody), 'joined text stays visible on the overview, even without a title');
    await overview.click();
    await body.waitFor();
    assert.ok((await body.innerText()).includes(joinedBody), 'joined text stays visible in the editor');
    await close();
    assert.equal((await api(`/notes/${item.id}`)).noteBody, original, 'reading an affected note does not rewrite its URLs');
  }
  await open(redirect.id);
  assert.equal(await body.locator('.editor-link-preview-card').count(), 1, 'a redirect URL with a nested query URL remains one preview');
  await close();
  assert.equal((await api(`/notes/${redirect.id}`)).noteBody, redirectUrl);
  console.log('PASS: existing joined URL text remains visible in both views; redirect URLs remain intact');

  // Receiving saved content must rebuild cards, but a metadata-only update
  // must leave the existing hydrated body alone.
  await open(live.id);
  const liveBody = `${url}<br>${adjacentUrls[0]}<br>Incoming preview update`;
  await api(`/notes/${live.id}`, { noteBody: liveBody }, 'PATCH', collaboratorToken);
  await body.filter({ hasText: 'Incoming preview update' }).waitFor();
  assert.equal(await body.locator('.editor-link-preview-card').count(), 2, 'incoming links are hydrated');
  await body.locator('.editor-link-preview-card').first().evaluate(el => el.dataset['previewRegression'] = 'stable');
  await api(`/notes/${live.id}`, { noteTitle: 'Updated preview title' }, 'PATCH', collaboratorToken);
  await editor.getByRole('textbox', { name: 'Title', exact: true }).filter({ hasText: 'Updated preview title' }).waitFor();
  assert.equal(await body.locator('[data-preview-regression="stable"]').count(), 1, 'unchanged content retains its hydrated cards');
  await close();
  console.log('PASS: incoming link changes rebuild cards; metadata-only refreshes retain existing cards');

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
