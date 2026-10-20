import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. A mapped .test hostname exercises a genuinely
// insecure HTTP context; loopback alone would expose randomUUID and miss #92.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  const setup = await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  assert.equal(setup.status, 201);
  await fixture.sql('UPDATE users SET demoNotesCreatedAt = ?', [new Date().toISOString()]);
  browser = await chromium.launch({ headless: true, args: [
    '--host-resolver-rules=MAP kept-http.test 127.0.0.1', '--no-proxy-server'
  ] });
  for (const secure of [false, true]) {
    const origin = secure ? fixture.origin : fixture.origin.replace('127.0.0.1', 'kept-http.test');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const capabilities = await page.evaluate(() => ({
        secure: window.isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues
      }));
      assert.deepEqual(capabilities, { secure, uuid: secure ? 'function' : 'undefined', random: 'function' });
      await page.getByLabel('Username', { exact: true }).fill(credentials.username);
      await page.getByLabel('Password', { exact: true }).fill(credentials.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.locator('app-notes').waitFor();
      await page.locator('app-input .placeholder:visible').click();
      const editor = page.locator('app-input .note-main:visible').last();
      const title = `UUID ${secure ? 'native' : 'HTTP fallback'}`;
      const response = page.waitForResponse(r => r.request().method() === 'POST' && (r.url().endsWith('/api/notes') || (r.url().endsWith('/api/sync/mutations') && r.request().postDataJSON()?.mutations?.some(mutation => mutation.type === 'note.upsert' && mutation.payload?.noteTitle === title))));
      await editor.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
      await editor.locator('.note-body[contenteditable]').fill('Saved without changing the browser crypto API.');
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      assert.ok((await response).ok());
      await editor.waitFor({ state: 'hidden' });
      const rows = await fixture.sql('SELECT syncId, noteBody FROM notes WHERE noteTitle = ?', [title]);
      assert.equal(rows.length, 1);
      assert.match(rows[0].syncId, /^note-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.match(rows[0].noteBody, /Saved without changing/);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('app-notes').getByText(title, { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`PASS ${secure ? 'secure loopback / built-in UUID' : 'insecure HTTP / fallback UUID'}: sign-in, note save, stored UUID and reload`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  await fixture.close();
}
