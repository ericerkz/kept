import assert from 'node:assert/strict';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture(); let browser;
try {
  const credentials = { username: 'media-touch', password: 'test-media-touch-password' };
  let token;
  const api = async (path, body) => {
    const response = await fetch(fixture.origin + '/api' + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
  };
  await api('/setup/admin', credentials);
  await fixture.sql('UPDATE users SET demoNotesCreatedAt = ?', [new Date().toISOString()]);
  const session = await api('/auth/login', credentials); token = session.token;
  const form = new FormData();
  const photoBytes = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#a7cfbb' } }).png().toBuffer();
  form.append('image', new Blob([photoBytes], { type: 'image/png' }), 'touch-photo.png');
  const upload = await fetch(fixture.origin + '/api/uploads/images', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(upload.status, 201); const photoUrl = (await upload.json()).url;
  const create = body => api('/notes', { noteTitle: '', noteBody: body, images: [], labels: [], checkBoxes: [] });
  const photo = await create(`<div><img src="${photoUrl}" alt="Only photo"></div>`);
  const linkUrl = 'https://example.com/notes';
  const link = await create(`<p>${linkUrl}</p>`);
  const neighbour = await create('<p>Reorder neighbour</p>');
  const original = await fixture.sql('SELECT id, noteTitle, noteBody, images, archived, trashed FROM notes ORDER BY id');
  browser = await chromium.launch();
  for (const platform of ['android', 'ios']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    await context.addInitScript(({ platform, session }) => {
      window.CapacitorCustomPlatform = { name: platform };
      localStorage.setItem('gk_session', JSON.stringify({ ...session.user, token: session.token }));
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
      window.openedLinks = []; window.copiedLinks = [];
      window.open = url => { window.openedLinks.push(url); return null; };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.copiedLinks.push(text) } });
    }, { platform, session });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/link-preview**', route => route.fulfill({ json: { title: 'Example preview', domain: 'example.com', image: `data:image/png;base64,${photoBytes.toString('base64')}`, url: linkUrl } }));
    await page.goto(fixture.origin);
    const card = note => page.locator(`app-notes .note-container[data-note-id="${note.id}"]`);
    const media = note => card(note).locator(note === photo ? '.preview-image-tile img' : '.lp-thumb');
    await media(photo).waitFor(); await media(link).waitFor();
    const client = await context.newCDPSession(page);
    const start = (x, y) => client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    const move = (x, y) => client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
    const end = () => client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const point = async element => { await element.scrollIntoViewIfNeeded(); const box = await element.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
    const assertClosed = async () => assert.notEqual(await page.locator('app-notes > .modal-container').evaluate(el => el.style.display), 'block');
    const order = () => page.locator('app-notes .notes-layout .note-container').evaluateAll(cards => cards.map(card => card.dataset.noteId));
    for (const note of [photo, link]) {
      const p = await point(media(note)); await start(p.x, p.y);
      await page.locator('.touch-dragging-ghost').waitFor(); await end();
      await card(note).locator('xpath=self::*[contains(@class,"selected")]').waitFor();
      await assertClosed();
      assert.deepEqual(await page.evaluate(() => window.openedLinks), []);
      await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
      await page.waitForTimeout(400);
      const before = await order();
      const from = await point(media(note)), to = await point(card(neighbour).locator('.body'));
      await start(from.x, from.y); await page.locator('.touch-dragging-ghost').waitFor();
      await move(to.x, to.y); await page.waitForTimeout(180); await end();
      await page.locator('.touch-dragging-ghost').waitFor({ state: 'hidden' });
      assert.notDeepEqual(await order(), before, 'holding the actual preview can reorder the note');
      await assertClosed();
      assert.equal(await card(note).evaluate(el => el.classList.contains('selected')), false, 'dragging must not also toggle selection');
      await page.waitForTimeout(400);
    }
    // Both media-only types can participate in the same multi-selection.
    for (const note of [photo, link]) {
      const p = await point(media(note)); await start(p.x, p.y);
      await page.locator('.touch-dragging-ghost').waitFor(); await end();
      await card(note).locator('xpath=self::*[contains(@class,"selected")]').waitFor();
    }
    assert.equal(await page.locator('app-notes .note-container.selected').count(), 2);
    await assertClosed();
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await page.waitForTimeout(400);
    // Preview taps retain their normal actions; link action buttons never pick up a note.
    const imagePoint = await point(media(photo)); await page.touchscreen.tap(imagePoint.x, imagePoint.y);
    await page.locator('app-notes > .modal-container app-input .note-body img').waitFor();
    await page.locator('app-notes > .modal-container .mobile-top-bar .back').click();
    await page.locator('app-notes > .modal-container').waitFor({ state: 'hidden' });
    await page.waitForTimeout(400);
    await card(link).locator('.lp-title').tap();
    await page.locator('app-notes > .modal-container app-input .note-main').waitFor();
    await page.locator('app-notes > .modal-container .mobile-top-bar .back').click();
    await page.locator('app-notes > .modal-container').waitFor({ state: 'hidden' });
    await page.waitForTimeout(400);
    const copy = card(link).locator('.lp-actions button').first();
    const copyPoint = await point(copy); await start(copyPoint.x, copyPoint.y); await page.waitForTimeout(500);
    assert.equal(await page.locator('.touch-dragging-ghost').count(), 0, 'holding a real link action must not drag the note');
    await end();
    await copy.tap();
    await card(link).locator('.lp-actions button').last().tap();
    assert.ok((await page.evaluate(() => window.copiedLinks)).every(url => url === linkUrl));
    assert.ok((await page.evaluate(() => window.copiedLinks)).length > 0);
    assert.deepEqual(await page.evaluate(() => window.openedLinks), [linkUrl]);
    await assertClosed();
    assert.deepEqual(errors, []);
    assert.equal(JSON.stringify(await fixture.sql('SELECT id, noteTitle, noteBody, images, archived, trashed FROM notes ORDER BY id')), JSON.stringify(original), 'gestures preserve note contents and archive/trash state');
    console.log(`PASS ${platform}: image/link thumbnail holds select, drags reorder, normal taps open notes, copy/open controls stay separate, content unchanged`);
    await context.close();
  }
} finally { await browser?.close(); await fixture.close(); }
