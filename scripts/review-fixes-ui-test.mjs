// node scripts/review-fixes-ui-test.mjs   (needs `npm run build` first)
// Browser checks for the bundled snackbar (H1), Ctrl+Enter / phone
// "save and start a new note" (#179) and the
// backup retention settings (#171), encrypted note/file lifecycle (#27).
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
const credentials = { username: 'review-owner', password: 'review-fixes-ui-password' };
let token;
async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${fixture.origin}/api${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, `${method} ${path}: ${await response.clone().text()}`);
  return response.status === 204 ? null : response.json();
}
async function signIn(page) {
  await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('app-notes').waitFor();
}
const notesTitled = async title => (await api('/notes?limit=100')).filter?.(note => note.noteTitle === title)
  ?? (await api('/notes?limit=100')).notes.filter(note => note.noteTitle === title);
async function waitFor(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  assert.fail(message);
}

try {
  await api('/setup/admin', credentials);
  token = (await api('/auth/login', credentials)).token;
  await api('/users/me/mark-demo-notes-created', {});
  browser = await chromium.launch({ headless: true });

  // ── Desktop ───────────────────────────────────────────────────────────
  {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const problems = [], external = [];
    page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (/Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text()); });
    if (process.env.DEBUG_CONSOLE) page.on('response', async response => { if (response.status() >= 400) console.log('[HTTP]', response.status(), response.url(), (await response.text()).slice(0, 400)); });
    if (process.env.DEBUG_CONSOLE) page.on('console', message => { if (['warning', 'error'].includes(message.type())) console.log('[browser]', message.type(), message.text().slice(0, 300)); });
    page.on('request', request => { if (/jsdelivr/.test(request.url())) external.push(request.url()); });
    page.on('dialog', dialog => dialog.accept(dialogAnswers.shift() ?? ''));
    let dialogAnswers = [];
    await signIn(page);

    // H1: the snackbar is bundled, works, and no CDN script is requested.
    const csp = (await (await fetch(fixture.origin)).headers.get('content-security-policy')) || '';
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp, /jsdelivr/);
    assert.equal(await page.evaluate(() => typeof window.Snackbar?.show), 'function');
    await page.evaluate(() => window.Snackbar.show({ text: '<img src=x onerror="window.__xss=1">Saved', duration: 0 }));
    const bar = page.locator('.snackbar-container').last();
    await bar.waitFor();
    assert.equal(await bar.locator('p').textContent(), '<img src=x onerror="window.__xss=1">Saved');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    console.log('✔ snackbar bundled, text-only, no CDN request');

    // #179: Ctrl+Enter saves the note and opens a fresh composer.
    await page.locator('app-input .placeholder:visible input').click();
    const editor = page.locator('app-input .note-main:visible').first();
    await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Rapid one');
    await editor.locator('.note-body[contenteditable]:not(.note-body-after)').fill('first quick note');
    await page.keyboard.press('Control+Enter');
    await waitFor(async () => (await notesTitled('Rapid one')).length === 1, 'Ctrl+Enter saved the note');
    const next = page.locator('app-input .note-main:visible').first();
    await next.waitFor();
    await waitFor(async () => (await next.getByRole('textbox', { name: 'Title', exact: true }).textContent()) === ''
      && (await next.locator('.note-body[contenteditable]:not(.note-body-after)').textContent()).trim() === '', 'fresh, empty composer');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('app-input .note-main')), true, 'focus is in the new composer');
    await page.keyboard.type('second quick note');
    await page.keyboard.press('Meta+Enter');
    await waitFor(async () => {
      const list = await api('/notes?limit=100');
      return (list.notes || list).some(note => /second quick note/.test(note.noteBody || note.previewText || ''));
    }, '⌘+Enter saved the second note');
    console.log('✔ Ctrl/⌘+Enter saves and starts the next note');
    await page.keyboard.press('Escape');

    // #27: lock a note from the editor; the server only gets ciphertext.
    const secret = await api('/notes', { noteTitle: 'Bank', noteBody: '<p>PIN-1234-SECRET</p>', labels: [], images: [], checkBoxes: [] });
    await page.reload();
    await page.locator('app-notes').waitFor();
    await page.getByText('Bank', { exact: true }).first().click();
    const modal = page.locator('app-input .note-main:visible').last();
    await modal.locator('.note-body[contenteditable]').first().waitFor();
    await modal.locator('.more').first().click();
    dialogAnswers = ['correct horse battery', 'correct horse battery'];
    await page.getByText('Lock note', { exact: true }).click();
    await waitFor(async () => (await api(`/notes/${secret.id}`)).lockHash === 'e2e:v1', 'note locked with encryption');
    const stored = await api(`/notes/${secret.id}`);
    assert.equal(stored.noteBody, '');
    assert.ok(stored.encryptedContent.length > 0);
    assert.doesNotMatch(stored.encryptedContent, /PIN-1234/);
    // Editing while unlocked re-seals; the server still never sees plaintext.
    await modal.locator('.note-body[contenteditable]').first().fill('PIN-1234-SECRET and EDITED-LATER');
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await waitFor(async () => (await api(`/notes/${secret.id}`)).encryptedContent !== stored.encryptedContent, 'edit re-sealed');
    const edited = await api(`/notes/${secret.id}`);
    assert.equal(edited.noteBody, '');
    assert.doesNotMatch(JSON.stringify(edited), /EDITED-LATER|PIN-1234/);
    // A fresh page needs the passcode; the card never shows the content.
    await page.reload();
    await page.locator('app-notes').waitFor();
    const card = page.locator(`app-notes [data-note-id="${secret.id}"]`);
    await card.waitFor();
    assert.match(await card.textContent(), /Locked note/);
    const editorsBefore = await page.locator('app-input .note-main:visible').count();
    dialogAnswers = ['wrong passcode', ''];
    await card.click();
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('app-input .note-main:visible').count(), editorsBefore, 'wrong passcode does not open it');
    dialogAnswers = ['correct horse battery'];
    await card.click();
    const reopened = page.locator('app-input .note-main:visible').last();
    await reopened.getByText('EDITED-LATER').waitFor();
    console.log('✔ locked notes are encrypted, re-sealed on edit, and need the passcode to open');
    await reopened.getByRole('button', { name: 'Close', exact: true }).click();

    // #27: a note's image and attachment are encrypted with it, shown
    // decrypted in the editor, downloadable, and restored when unlocking.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
    const imageForm = new FormData();
    imageForm.append('image', new Blob([png], { type: 'image/png' }), 'secret-photo.png');
    const uploadedImage = await (await fetch(`${fixture.origin}/api/uploads/images`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: imageForm })).json();
    const withFiles = await api('/notes', { noteTitle: 'Passport', noteBody: `<p>scan below</p><img src="${uploadedImage.url}" alt="secret-photo.png">`, labels: [], images: [], checkBoxes: [] });
    const fileForm = new FormData();
    fileForm.append('file', new Blob(['ATTACHMENT-SECRET'], { type: 'text/plain' }), 'secret.txt');
    assert.equal((await fetch(`${fixture.origin}/api/notes/${withFiles.id}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fileForm })).status, 201);
    await page.reload();
    await page.locator('app-notes').waitFor();
    await page.getByText('Passport', { exact: true }).first().click();
    const filesEditor = page.locator('app-input .note-main:visible').last();
    await filesEditor.locator('.attachment-name', { hasText: 'secret.txt' }).waitFor();
    await filesEditor.locator('.more').first().click();
    dialogAnswers = ['file passcode', 'file passcode'];
    await page.getByText('Lock note', { exact: true }).click();
    await waitFor(async () => {
      const current = await api(`/notes/${withFiles.id}`);
      return current.lockHash === 'e2e:v1' && current.images.length === 0
        && current.attachments.length === 2 && current.attachments.every(row => row.originalName === 'encrypted.keptenc');
    }, 'image and attachment replaced by encrypted copies').catch(async error => {
      if (process.env.DEBUG_CONSOLE) console.log('LOCK DEBUG', await api(`/notes/${withFiles.id}`), await page.locator('.snackbar-container').allTextContents());
      throw error;
    });
    const lockedFiles = await api(`/notes/${withFiles.id}`);
    assert.doesNotMatch(lockedFiles.encryptedContent, /secret\.txt|secret-photo|scan below/);
    for (const row of lockedFiles.attachments) {
      const bytes = Buffer.from(await (await fetch(`${fixture.origin}/api/attachments/${row.id}`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), 'KEF1');
      assert.ok(!bytes.includes('ATTACHMENT-SECRET'), 'attachment bytes are encrypted');
    }
    const plainImage = await fetch(`${fixture.origin}${uploadedImage.url}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(plainImage.status, 404, 'the unencrypted image is gone from the server');
    // The open editor shows the decrypted image without reloading.
    await waitFor(() => filesEditor.locator('img[src^="blob:"]').first().evaluate(img => img.complete && img.naturalWidth > 0).catch(() => false), 'editor shows the decrypted image');
    await filesEditor.getByRole('button', { name: 'Close', exact: true }).click();
    // Reopened on a fresh page: decrypted image, original name, downloadable.
    await page.reload();
    await page.locator('app-notes').waitFor();
    dialogAnswers = ['file passcode'];
    await page.locator(`app-notes [data-note-id="${withFiles.id}"]`).click();
    const lockedEditor = page.locator('app-input .note-main:visible').last();
    await lockedEditor.locator('.attachment-name', { hasText: 'secret.txt' }).waitFor();
    await waitFor(() => lockedEditor.locator('img[src^="blob:"]').first().evaluate(img => img.complete && img.naturalWidth > 0).catch(() => false), 'reopened note shows the decrypted image');
    const [download] = await Promise.all([page.waitForEvent('download'), lockedEditor.locator('.attachment-card', { hasText: 'secret.txt' }).click()]);
    assert.equal(download.suggestedFilename(), 'secret.txt');
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'ATTACHMENT-SECRET');

    // Changing the passcode rotates the key: new encrypted copies replace
    // the old ones, and only the new passcode opens the note.
    const beforeRotation = await api(`/notes/${withFiles.id}`);
    await lockedEditor.locator('.more').first().click();
    dialogAnswers = ['rotated passcode', 'rotated passcode'];
    await page.getByText('Change passcode', { exact: true }).click();
    await waitFor(async () => {
      const current = await api(`/notes/${withFiles.id}`);
      const oldIds = new Set(beforeRotation.attachments.map(row => row.id));
      return current.lockSalt !== beforeRotation.lockSalt && current.attachments.length === 2
        && current.attachments.every(row => row.originalName === 'encrypted.keptenc' && !oldIds.has(row.id));
    }, 'files re-encrypted under the new key and the old copies removed');
    assert.equal(JSON.parse((await api(`/notes/${withFiles.id}`)).encryptedContent).epoch, 2);
    await waitFor(() => lockedEditor.locator('img[src^="blob:"]').first().evaluate(img => img.complete && img.naturalWidth > 0).catch(() => false), 'image still shown after the passcode change');
    await lockedEditor.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await page.locator('app-notes').waitFor();
    const rotatedCard = page.locator(`app-notes [data-note-id="${withFiles.id}"]`);
    const editorsClosed = await page.locator('app-input .note-main:visible').count();
    dialogAnswers = ['file passcode'];
    await rotatedCard.click();
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('app-input .note-main:visible').count(), editorsClosed, 'the old passcode no longer opens it');
    dialogAnswers = ['rotated passcode'];
    await rotatedCard.click();
    await lockedEditor.locator('.attachment-name', { hasText: 'secret.txt' }).waitFor();
    await waitFor(() => lockedEditor.locator('img[src^="blob:"]').first().evaluate(img => img.complete && img.naturalWidth > 0).catch(() => false), 'new passcode shows the decrypted image');
    const [rotatedDownload] = await Promise.all([page.waitForEvent('download'), lockedEditor.locator('.attachment-card', { hasText: 'secret.txt' }).click()]);
    const rotatedChunks = [];
    for await (const chunk of await rotatedDownload.createReadStream()) rotatedChunks.push(chunk);
    assert.equal(Buffer.concat(rotatedChunks).toString(), 'ATTACHMENT-SECRET');
    console.log('✔ changing the passcode re-encrypts the note and its files under a new key');

    // Removing the lock puts the image and attachment back in the clear.
    await lockedEditor.locator('.more').first().click();
    await page.getByText('Remove lock', { exact: true }).click();
    await waitFor(async () => {
      const current = await api(`/notes/${withFiles.id}`);
      return !current.locked && /scan below/.test(current.noteBody) && /\/api\/uploads\/images\//.test(current.noteBody)
        && current.attachments.length === 1 && current.attachments[0].originalName === 'secret.txt';
    }, 'note, image and attachment back in the clear');
    const restored = await api(`/notes/${withFiles.id}`);
    const restoredBytes = await (await fetch(`${fixture.origin}/api/attachments/${restored.attachments[0].id}`, { headers: { Authorization: `Bearer ${token}` } })).text();
    assert.equal(restoredBytes, 'ATTACHMENT-SECRET');
    console.log('✔ images and attachments are encrypted with the note, viewable, downloadable and restored on unlock');
    await lockedEditor.getByRole('button', { name: 'Close', exact: true }).click();

    // #171: retention policy in User Management.
    await page.goto(`${fixture.origin}/users`);
    const section = page.locator('.retention-section');
    await section.waitFor();
    await section.locator('select').selectOption('smart');
    await section.locator('.retention-smart input').first().fill('5');
    await section.getByRole('button', { name: 'Save', exact: true }).click();
    await section.getByText('Retention policy saved.').waitFor();
    const status = await api('/admin/backup/status');
    assert.deepEqual(status.retention, { mode: 'smart', includeManual: false, daily: 5, weekly: 4, monthly: 12, yearly: 0 });
    console.log('✔ backup retention policy saves from the admin UI');

    assert.deepEqual(external, [], 'no jsDelivr requests');
    assert.deepEqual(problems, [], 'no page errors or CSP violations');
    await context.close();
  }

  // ── Phone ─────────────────────────────────────────────────────────────
  {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await signIn(page);
    // The phone layout's floating "New note" button opens the full-screen composer.
    await page.locator('.mobile-compose-fab').click();
    const editor = page.locator('app-input .note-main:visible').first();
    await editor.waitFor();
    await editor.locator('.note-body[contenteditable]:not(.note-body-after)').fill('typed on the phone');
    const button = page.getByRole('button', { name: 'Save and start a new note' }).first();
    await button.waitFor();
    const box = await button.boundingBox(), bottomBar = await page.locator('.mobile-bottom-bar:visible').first().boundingBox();
    assert.ok(box.x + box.width <= 360 && box.x >= 0, 'button inside the screen width');
    assert.ok(box.y + box.height <= bottomBar.y + 1, 'button sits above the bottom bar');
    await page.screenshot({ path: process.env.SCREENSHOT || '/tmp/kept-phone-next-note.png' });
    await button.click();
    await waitFor(async () => {
      const list = await api('/notes?limit=100');
      return (list.notes || list).some(note => /typed on the phone/.test(note.noteBody || note.previewText || ''));
    }, 'phone button saved the note');
    const fresh = page.locator('app-input .note-main:visible').first();
    await fresh.waitFor();
    assert.equal((await fresh.locator('.note-body[contenteditable]:not(.note-body-after)').textContent()).trim(), '');
    console.log('✔ phone button saves and opens a fresh note, above the bottom bar');
    await context.close();
  }
} finally {
  await browser?.close();
  await fixture.close();
}
