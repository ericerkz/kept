import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
try {
  const credentials = { username: 'sidebar-icons', password: 'isolated-sidebar-icons-password' };
  assert.ok((await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).ok);

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
      await page.locator('[sideBar]').waitFor({ state: 'attached' });
      const menu = page.locator('app-navbar .pic-container').first();
      async function openDrawer() {
        if (await page.locator('[sideBar].close').count()) await menu.click();
        await page.locator('[sideBar]:not(.close)').waitFor();
      }
      async function checkIcons(theme) {
        const icons = await page.locator('.sidenav-top > .item, .sidenav-bottom > .item').evaluateAll(items =>
          items.filter(item => getComputedStyle(item).display !== 'none').map(item => {
            const icon = item.firstElementChild;
            const style = getComputedStyle(icon);
            return { label: item.textContent.trim(), mask: style.maskImage, width: style.width,
              height: style.height, opacity: style.opacity, color: style.backgroundColor,
              active: item.classList.contains('active'), svg: icon.classList.contains('pic'),
              decorative: icon.getAttribute('aria-hidden') === 'true' };
          }));
        assert.ok(icons.length >= 8);
        for (const icon of icons) {
          assert.ok(icon.svg && icon.decorative, icon.label);
          assert.equal(icon.width, '24px', icon.label);
          assert.equal(icon.height, '24px', icon.label);
          assert.equal(icon.opacity, icon.active ? '0.87' : theme === 'light' ? '0.72' : '0.54', icon.label);
          assert.equal(icon.color, icon.active || theme === 'light' ? 'rgb(60, 64, 67)' : 'rgb(232, 234, 237)', icon.label);
          const url = icon.mask.match(/url\("?([^"\)]+)"?\)/)?.[1];
          assert.ok(url, icon.label);
          assert.ok((await context.request.get(url)).ok(), url);
        }
      }

      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width: 400, height: 800 });
        await openDrawer();
        if (await page.evaluate(() => document.body.classList.contains('light-theme')) !== (theme === 'light')) {
          await page.locator('.mobile-only-item').click();
          await page.waitForFunction(light => document.body.classList.contains('light-theme') === light, theme === 'light');
          await openDrawer();
        }
        await checkIcons(theme);
        assert.ok(await page.locator(theme === 'light' ? '.pic.dark-mode' : '.pic.light-mode').count());
        await page.setViewportSize({ width: 1200, height: 900 });
        await checkIcons(theme);
        await menu.click();
        await page.waitForFunction(() => document.querySelector('[sideBar]').getBoundingClientRect().width === 80);
        await checkIcons(theme);
      }
      await menu.click();
      await page.getByText('Attachments', { exact: true }).first().click();
      await page.waitForURL(fixture.origin + '/attachments');
      await page.locator('.item.active .pic.attachment').waitFor();
      await checkIcons('dark');
      await page.getByText('Sign out', { exact: true }).click();
      await page.waitForURL(fixture.origin + '/login');
      await context.close();
      console.log(`${browserType.name()}: sidebar SVGs, asset loading, themes, mobile/desktop, collapsed layout, navigation, and sign-out passed.`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.close();
}
