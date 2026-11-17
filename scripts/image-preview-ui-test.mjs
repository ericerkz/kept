import assert from 'node:assert/strict';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'preview-owner', password: 'test-preview-password' };
  let token;
  const api = async (route, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(fixture.origin + '/api' + route, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `API ${route}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  await api('/setup/admin', credentials);
  const session = await api('/auth/login', credentials);
  token = session.token;
  await api('/users/me/mark-demo-notes-created', {});
  session.user.demoNotesCreatedAt = new Date().toISOString();
  const zip = process.env.KEPT_IMAGE_REFERENCE_ARCHIVE ? new AdmZip(process.env.KEPT_IMAGE_REFERENCE_ARCHIVE) : null;
  const urls = [];
  for (const [index, [width, height, color]] of [[800,1200,'#f4bd82'],[800,1100,'#a7cfbb'],[1200,800,'#a9c5f3'],[1000,700,'#d3b1df']].entries()) {
    const name = `cat-${String.fromCharCode(97 + index)}.png`;
    const reference = zip?.getEntries().find(entry => entry.entryName.endsWith('/' + name));
    const bytes = reference ? reference.getData() : await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
    const form = new FormData(); form.append('image', new Blob([bytes], { type: 'image/png' }), name);
    const response = await fetch(fixture.origin + '/api/uploads/images', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    assert.equal(response.status, 201); urls.push((await response.json()).url);
  }
  const image = index => `<div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="${urls[index % 4]}" alt="Photo ${index}"></div>`;
  const create = (title, body, extra = {}) => api('/notes', { noteTitle: title, noteBody: body,
    images: [], checkBoxes: [], labels: [], bgColor: '', ...extra });
  const three = await create('Three photos', '<p>Wow</p>' + image(0) + image(1) + image(2), { bgColor: '#cbf0f8', labels: [{ name: 'Photos', added: true }], pattern: 'travel' });
  const mixed = await create('Between paragraphs', '<p><strong>First paragraph</strong> before the photo.</p>' + image(0) + '<h3>Kitchen</h3><p>Text belongs between these images.</p>' + image(1) + '<p>Another paragraph.</p>' + image(2));
  const many = await create('Twelve photos', '<p>First week home.</p>' + Array.from({ length: 12 }, (_, index) => image(index)).join(''));
  const cover = await create('Cover photo', image(0) + '<p>A cover, followed by the title and text.</p>', { bgColor: '#fff8b8' });
  const landscape = await create('Landscape', '<p>One photo.</p>' + image(3));
  const links = await create('', image(0) + '<p>' + Array.from({ length: 5 }, (_, index) => `https://example.com/${index}`).join('<br>') + '</p>');
  const top = await create('Legacy images', '<p>Between top and bottom images.</p>', { images: [
    { id: 'top', dataUrl: urls[0], name: 'Top photo', placement: 'top' },
    { id: 'bottom', dataUrl: urls[1], name: 'Bottom photo', placement: 'bottom' }
  ] });
  const drawing = await create('Drawing preview', '', { images: [{ id: 'drawing', dataUrl: urls[0], name: 'Drawing|bg:rules', placement: 'top' }] });
  const textNote = await create('Text-only sync check', '<p>Edit and move this note without changing its neighbours.</p>');
  const savedImageNotes = () => fixture.sql('SELECT id, noteTitle, noteBody, images FROM notes WHERE id != ? ORDER BY id', [textNote.id]);
  const original = await savedImageNotes();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/link-preview**', route => route.fulfill({ json: { title: 'Example link', domain: 'example.com', image: null } }));
  await page.goto(fixture.origin + '/login');
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(fixture.origin + '/');
  const card = note => page.locator(`.note-container[data-note-id="${note.id}"]`);
  await card(three).waitFor();
  await card(three).locator('.preview-image-tile img').first().waitFor();
  assert.equal(await card(three).locator('.preview-grid .preview-image-tile').count(), 3);
  assert.equal(await card(three).locator('.preview-image-wide').count(), 1);
  assert.equal(await card(many).locator('.preview-image-tile').count(), 4);
  assert.equal(await card(many).locator('.preview-image-more').textContent(), '+9');
  assert.equal(await card(mixed).locator('.preview-grid').count(), 0, 'text-separated images never group');
  assert.equal(await card(mixed).locator('.body strong').textContent(), 'First paragraph', 'formatting around images is preserved');
  assert.equal(await card(mixed).locator('.body h3').textContent(), 'Kitchen');
  assert.equal(await card(cover).locator('.preview-cover').count(), 1);
  assert.ok((await card(cover).locator('.preview-cover').boundingBox()).y < (await card(cover).locator('.title').boundingBox()).y);
  assert.equal(await card(top).locator('.preview-cover').count(), 1, 'legacy top images can be covers too');
  assert.equal(await card(links).locator('.link-overflow-chip').textContent(), '+2 links');
  assert.equal(await card(links).locator('app-link-preview').count(), 3);
  assert.equal(await card(links).locator('.preview-image-tile').count(), 1, 'link-only classification must not hide images');
  assert.equal(await card(drawing).locator('app-note-preview-images').count(), 0, 'drawings retain their original paper preview');
  assert.equal(await card(drawing).locator('img[data-drawing-background="rules"]').count(), 1);
  await card(mixed).locator('.preview-overflow-pill').waitFor();
  assert.match(await card(mixed).locator('.preview-overflow-pill').textContent(), /\+\d+ images?/);
  const close = async () => {
    const desktop = page.locator('app-input .close-btn:visible');
    if (await desktop.count()) await desktop.first().click();
    else await page.locator('app-input .mobile-top-bar button').first().click();
    await page.locator('app-notes > .modal-container').waitFor({ state: 'hidden' });
  };
  // Saving/moving any note replaces list snapshots during sync. Unchanged
  // photos must retain their decoded <img> nodes and URLs through those updates.
  await page.waitForFunction(id => {
    const images = [...document.querySelectorAll(`.note-container[data-note-id="${id}"] .preview-image-tile img`)];
    return images.length === 3 && images.every(image => image.complete && image.naturalWidth);
  }, three.id);
  await page.evaluate(id => {
    const host = document.querySelector(`.note-container[data-note-id="${id}"]`);
    const images = [...host.querySelectorAll('.preview-image-tile img')];
    window.previewStability = { images, sources: images.map(image => image.src), removed: 0, changed: 0 };
    window.previewObserver = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes' && images.includes(record.target)) window.previewStability.changed++;
        for (const node of record.removedNodes) {
          if (images.some(image => node === image || node.contains(image))) window.previewStability.removed++;
        }
      }
    });
    window.previewObserver.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  }, three.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    await card(textNote).locator('.title').click();
    await page.locator('.modal app-input .note-title[contenteditable]').fill(`Text sync check ${attempt}`);
    await close();
    await page.waitForFunction(({ id, title }) => document.querySelector(`.note-container[data-note-id="${id}"] .title`)?.textContent.includes(title),
      { id: textNote.id, title: `Text sync check ${attempt}` });
    await card(textNote).hover();
    await card(textNote).locator('.pin-icon').click();
    await page.waitForTimeout(350);
  }
  assert.deepEqual(await page.evaluate(() => {
    window.previewObserver.disconnect();
    const state = window.previewStability;
    return { removed: state.removed, changed: state.changed, intact: state.images.every((image, i) => image.isConnected && image.src === state.sources[i] && image.complete && image.naturalWidth > 0) };
  }), { removed: 0, changed: 0, intact: true }, 'unrelated edits and moves must not reset image previews during sync');
  console.log('PASS: unchanged image previews retain their nodes and decoded sources during repeated edits, moves and sync');
  await card(many).locator('.preview-image-more').click();
  const editorImages = page.locator('.modal app-input .note-body img');
  await editorImages.first().waitFor();
  assert.equal(await editorImages.count(), 12, 'the full editor still contains all photos');
  await page.waitForTimeout(350);
  const target = await editorImages.nth(3).boundingBox();
  assert.ok(target.y >= 0 && target.y < 1000, 'the overflow tile opens at its first represented image');
  await close();
  await card(mixed).locator('.preview-overflow-pill').click();
  assert.equal(await page.locator('.modal app-input .note-body img').count(), 3);
  await page.waitForTimeout(350);
  const omitted = await page.locator('.modal app-input .note-body img').nth(1).boundingBox();
  assert.ok(omitted.y >= 0 && omitted.y < 1000, 'the image pill opens at the first omitted image');
  await close();
  if (process.env.KEPT_IMAGE_SCREENSHOTS) await page.screenshot({ path: '/tmp/kept-image-desktop.png' });
  const sizes = [[1440,1000], [390,844], [320,740], [978,669]];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(600);
    if (width < 600 && !await page.locator('app-sidenav .main-sidebar').evaluate(element => element.classList.contains('close'))) {
      await page.locator('app-navbar .pic-container').first().click();
      await page.waitForTimeout(350);
    }
    const geometry = await card(three).evaluate(element => {
      const clip = element.querySelector('.note-preview-window').getBoundingClientRect();
      const labels = element.querySelector('.labels-container').getBoundingClientRect();
      return { width: element.clientWidth, height: clip.height, bottom: clip.bottom, labelsTop: labels.top };
    });
    assert.ok(geometry.height <= Math.min(520, Math.max(300, geometry.width * 1.6)) + 2, JSON.stringify(geometry));
    assert.ok(geometry.labelsTop >= geometry.bottom - 1, 'labels stay outside the clipped content');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const dark of [false, true]) {
      await page.evaluate(dark => { document.body.classList.toggle('light-theme', !dark); dispatchEvent(new Event('resize')); }, dark);
      if (process.env.KEPT_IMAGE_SCREENSHOTS && width === 390) await page.screenshot({ path: `/tmp/kept-image-${dark ? 'dark' : 'light'}.png` });
    }
  }
  assert.equal(JSON.stringify(await savedImageNotes()) === JSON.stringify(original), true,
    'overview previews and opening photos must not rewrite saved content');
  assert.deepEqual(errors, []);
  console.log('PASS: grouped/in-situ/cover previews, overflow counts and navigation, full editor, formatting, links, responsive limits, themes and unchanged stored notes');
  await context.close();
  // Native bearer URLs must retain the preview size; cached/offline originals
  // remain a fallback rather than becoming a broken unauthenticated image.
  const native = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await native.addInitScript(session => {
    window.CapacitorCustomPlatform = { name: 'ios' };
    localStorage.setItem('gk_session', JSON.stringify({ ...session.user, token: session.token }));
    localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
  }, session);
  const nativePage = await native.newPage();
  const previews = []; nativePage.on('request', request => { if (request.url().includes('?preview=')) previews.push(request); });
  await nativePage.route('**/api/link-preview**', route => route.fulfill({ json: {} }));
  await nativePage.goto(fixture.origin);
  await nativePage.locator(`.note-container[data-note-id="${three.id}"] .preview-image-tile img`).first().waitFor();
  assert.ok(previews.length > 0);
  assert.ok(previews.every(request => request.headers().authorization === `Bearer ${session.token}`));
  await native.setOffline(true);
  await nativePage.locator('app-navbar .view').click();
  await nativePage.locator('.preview-image-tile img').first().waitFor();
  await nativePage.waitForFunction(() => { const image = document.querySelector('.preview-image-tile img'); return image?.complete && image.naturalWidth > 0; });
  console.log('PASS: native authenticated thumbnail requests and offline image fallback');
  await native.close();
  const local = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await local.addInitScript(() => {
    window.CapacitorCustomPlatform = { name: 'ios' };
    localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
  });
  const localPage = await local.newPage();
  await localPage.goto(fixture.origin + '/welcome');
  await localPage.getByRole('button', { name: /Use on this device/ }).click();
  await localPage.waitForURL(fixture.origin + '/');
  await localPage.locator('.mobile-compose-fab').waitFor();
  await local.setOffline(true);
  await localPage.locator('.mobile-compose-fab').click();
  await localPage.locator('.note-title[contenteditable]:visible').fill('Local images');
  const localPhoto = await sharp({ create: { width: 800, height: 1200, channels: 3, background: 'coral' } }).png().toBuffer();
  await localPage.locator('.note-body[contenteditable]:visible').first().evaluate((element, photo) => {
    element.innerHTML = '<p>Local photos</p>' + Array.from({ length: 3 }, () => `<div><img src="data:image/png;base64,${photo}" alt="Local photo"></div>`).join('');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  }, localPhoto.toString('base64'));
  await localPage.locator('app-input .mobile-top-bar button').first().click();
  const localCard = localPage.locator('.note-container').filter({ hasText: 'Local images' });
  await localCard.locator('.preview-image-tile img').first().waitFor();
  assert.equal(await localCard.locator('.preview-image-tile').count(), 3);
  await localPage.waitForFunction(() => {
    const card = [...document.querySelectorAll('.note-container')].find(card => card.textContent.includes('Local images'));
    const image = card?.querySelector('.preview-image-tile img');
    return image?.complete && Math.max(image.naturalWidth, image.naturalHeight) <= 320;
  });
  console.log('PASS: device-only notes created offline group images and render cached small previews');
  await local.close();
} finally { await browser?.close(); await fixture.close(); }
