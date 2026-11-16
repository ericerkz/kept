import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
try {
  browser = await (process.env.KEPT_TEST_BROWSER === 'firefox' ? firefox : chromium).launch();
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  const login = await (await fetch(fixture.origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).json();
  const headers = { Authorization: 'Bearer ' + login.token };
  await fetch(fixture.origin + '/api/users/me/mark-demo-notes-created', { method: 'POST', headers });
  const notes = async () => (await fetch(fixture.origin + '/api/notes', { headers })).json();
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(message);
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
  await page.goto(fixture.origin + '/login');
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(fixture.origin + '/');
  const canvas = page.locator('canvas:visible').first();
  const ink = () => canvas.evaluate(c => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) count++;
    return count;
  });
  const stroke = async (offset = 0) => {
    await canvas.waitFor();
    await until(() => canvas.evaluate(c => c.width >= 640 && c.height >= 360), 'canvas not initialized');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 150, box.y + 120 + offset);
    await page.mouse.down();
    await page.mouse.move(box.x + 350, box.y + 220 + offset, { steps: 30 });
    await page.mouse.move(box.x + 230, box.y + 280 + offset, { steps: 20 });
    await page.mouse.up();
    await until(async () => await ink() > 0, 'stroke not painted');
  };
  const back = async () => {
    await page.getByRole('button', { name: 'Back', exact: true }).first().click();
    await canvas.waitFor({ state: 'hidden' });
  };
  const menu = async name => {
    await page.getByRole('button', { name: 'More', exact: true }).first().click();
    await page.getByRole('button', { name, exact: true }).click();
  };
  const open = async id => {
    await page.locator(`[data-note-id="${id}"]`).first().click();
    await canvas.waitFor();
    await until(async () => await ink() > 0, 'persisted drawing did not reopen with ink');
  };
  const drawing = note => note.images.find(image => image.id === 'drawing');

  await page.locator('[data-pop="New note with drawing"]').first().click();
  await stroke();
  await back();
  await until(async () => (await notes()).length === 1, 'original did not sync');
  const originalId = (await notes())[0].id;
  assert.equal((await fetch(fixture.origin + '/api/notes/' + originalId, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ noteTitle: 'Original drawing', noteBody: '<b>Preserved body</b>' })
  })).status, 204);
  const file = new FormData();
  file.append('file', new Blob(['preserve this attachment'], { type: 'text/plain' }), 'drawing-context.txt');
  assert.equal((await fetch(fixture.origin + `/api/notes/${originalId}/attachments`, {
    method: 'POST', headers, body: file
  })).status, 201);
  await page.reload();
  await page.locator(`[data-note-id="${originalId}"] .title`).filter({ hasText: 'Original drawing' }).waitFor();
  const original = (await notes())[0];
  assert.ok(original.id > 0);
  await open(original.id);
  assert.equal(await page.locator('.drawing-editor:visible > div[hidden]').first().textContent(), 'Original drawing',
    'drawing hydration must retain the original title before saving');
  const originalCanvasPng = await canvas.evaluate(c => c.toDataURL('image/png'));
  await menu('New drawing');
  await until(async () => await ink() === 0, 'fresh drawing is not blank');
  await stroke(60);
  await back();
  await until(async () => (await notes()).length === 2, 'New drawing must create a separate note');
  const saved = await notes();
  const preserved = saved.find(note => note.id === original.id);
  for (const key of ['id', 'syncId', 'noteTitle', 'noteBody', 'pinned', 'bgColor', 'bgImage', 'checkBoxes',
    'isCbox', 'labels', 'binder', 'archived', 'trashed', 'attachments']) {
    assert.deepEqual(preserved[key], original[key], `original ${key} must be preserved`);
  }
  assert.deepEqual(preserved.images, original.images.map(image =>
    image.id === 'drawing' ? { ...image, dataUrl: originalCanvasPng } : image),
  'saving must retain the reloaded original canvas and other images');
  const second = saved.find(note => note.id !== original.id);
  assert.ok(second.id > 0);
  assert.notEqual(second.syncId, original.syncId);
  assert.notEqual(drawing(second).dataUrl, drawing(original).dataUrl);
  assert.equal(second.noteTitle, '');
  assert.equal(second.noteBody, '');
  assert.deepEqual(second.attachments, []);
  await page.reload();
  await open(original.id);
  await back();
  await open(second.id);
  const secondInk = await ink();
  await menu('Delete current drawing');
  await until(async () => await ink() === 0, 'Delete must clear the current canvas');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await until(async () => await ink() > 0, 'Undo must restore the cleared drawing');
  assert.equal(await ink(), secondInk, 'Undo must restore the original stroke geometry');
  await back();
  await page.reload();
  await open(second.id);
  assert.equal(await ink(), secondInk, 'Undo restoration must survive reload');
  await back();

  // Switch before the initial 550ms debounce: save the draft once, never
  // let its pending timer create a blank replacement in the fresh composer.
  await page.locator('[data-pop="New note with drawing"]').first().click();
  await stroke(30);
  await menu('New drawing');
  await until(async () => await ink() === 0, 'unsaved draft did not open a fresh drawing');
  await until(async () => (await notes()).length === 3, 'unsaved original did not sync exactly once');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await notes()).length, 3, 'fresh blank drawing must not autosave from the previous draft timer');
  await stroke(90);
  await back();
  await until(async () => (await notes()).length === 4, 'new draft did not save separately');
  const final = await notes();
  assert.equal(new Set(final.map(note => note.id)).size, 4);
  assert.equal(new Set(final.map(note => note.syncId)).size, 4);
  assert.ok(final.every(note => note.id > 0));
  await page.reload();
  for (const note of final) {
    await open(note.id);
    await back();
  }
  // Fail the actual local persistence boundary, not a request the offline
  // outbox would legitimately accept as a successful local save.
  await open(original.id);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    window.restoreDrawingTestStorage = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'notes') throw new DOMException('Drawing test storage full', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await stroke(100);
  const dirtyInk = await ink();
  const dirtyDataUrl = await canvas.evaluate(c => c.toDataURL('image/png'));
  await menu('New drawing');
  await page.getByText("Note couldn't be saved", { exact: true }).first().waitFor();
  assert.equal(await ink(), dirtyInk, 'failed save must retain the accessible dirty canvas');
  assert.equal((await notes()).length, 4);
  await page.evaluate(() => window.restoreDrawingTestStorage());
  await menu('New drawing');
  await until(async () => await ink() === 0, 'retry did not open a fresh drawing');
  await until(async () => drawing((await notes()).find(note => note.id === original.id)).dataUrl === dirtyDataUrl,
    'dirty canvas could not be saved after recovering storage');
  assert.equal((await notes()).length, 4, 'retry must not create another old drawing note');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: saved and unsaved New drawing, distinct stable IDs, reload, Delete/Undo, save failure recovery');
} finally {
  await browser?.close();
  await fixture.close();
}
