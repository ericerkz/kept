import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
try {
  const credentials = { username: 'icon-test', password: 'isolated-icon-test-password' };
  const setup = await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  assert.ok(setup.ok);
  const login = await (await fetch(fixture.origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).json();
  const note = await fetch(fixture.origin + '/api/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ noteTitle: 'Icon consistency check', noteBody: 'Toolbar test', bgColor: '#d3e3fd' })
  });
  assert.ok(note.ok);

  for (const browserType of [chromium, firefox]) {
    const browser = await browserType.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 400, height: 800 }, serviceWorkers: 'block' });
      const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
      assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
        data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
      })).ok());
      await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed', '1'));
      const page = await context.newPage();
      await page.goto(fixture.origin);
      await page.getByText('Icon consistency check', { exact: true }).first().click();
      const bar = page.locator('app-input .mobile-bottom-bar:visible');
      await bar.waitFor();
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.body.classList.toggle('light-theme', theme === 'light'), theme);
        for (const viewport of [{ width: 400, height: 800 }, { width: 844, height: 390 }]) {
          await page.setViewportSize(viewport);
          const icons = await bar.locator('.glyph').evaluateAll(elements => elements.map(element => {
            const style = getComputedStyle(element);
            const button = getComputedStyle(element.parentElement);
            return { width: style.width, height: style.height, color: style.backgroundColor,
              parentColor: button.color, mask: style.maskImage, filter: style.filter,
              buttonHeight: button.height, buttonWidth: button.width };
          }));
          assert.equal(icons.length, 6);
          for (const icon of icons) {
            assert.equal(icon.width, '20px');
            assert.equal(icon.height, '20px');
            assert.equal(icon.color, icon.parentColor);
            assert.equal(icon.color, icons[0].color);
            assert.equal(icon.filter, 'none');
            assert.match(icon.mask, /\/assets\/images\/svg\/.+\.svg/);
            assert.equal(icon.buttonHeight, '44px');
            assert.equal(icon.buttonWidth, '44px');
            const url = icon.mask.match(/url\("?([^"\)]+)"?\)/)[1];
            assert.ok((await context.request.get(url)).ok(), url);
          }
        }
      }
      await bar.locator('.mobile-icon.color').click();
      await page.locator('.colorMenu:visible').waitFor();
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.locator('app-input .icons-container:visible').first().waitFor();
      assert.equal(await page.locator('app-input .mobile-bottom-bar:visible').count(), 0);
      await context.close();
      console.log(`${browserType.name()}: uniform mobile icon masks, colors, sizes, touch targets, landscape, and desktop passed.`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.close();
}
