import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
try {
  const credentials = { username: 'drawer-test', password: 'isolated-drawer-test-password' };
  const setup = await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  assert.ok(setup.ok, await setup.text());

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

      async function sample(action, halfway = false) {
        return page.evaluate(async ({ action, halfway }) => {
          const drawer = document.querySelector('[sideBar]');
          const backdrop = document.querySelector('.sidebar-backdrop');
          if (action === 'menu') document.querySelector('app-navbar .pic-container').click();
          if (action === 'backdrop') backdrop.click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          for (const element of [drawer, backdrop]) {
            for (const animation of element.getAnimations()) {
              if (halfway) {
                animation.pause();
                animation.currentTime = animation.effect.getTiming().duration / 2;
              } else animation.finish();
            }
          }
          const style = getComputedStyle(drawer);
          const rect = drawer.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, position: style.position,
            background: style.backgroundColor, visibility: style.visibility, inert: drawer.inert,
            backdropOpacity: Number(getComputedStyle(backdrop).opacity),
            backdropVisibility: getComputedStyle(backdrop).visibility };
        }, { action, halfway });
      }

      for (const width of [400, 599]) {
        await page.setViewportSize({ width, height: 800 });
        for (const close of ['menu', 'backdrop']) {
          const opening = await sample('menu', true);
          assert.ok(opening.left < 0 && opening.right > 0, JSON.stringify(opening));
          assert.equal(opening.inert, false);
          const opened = await sample();
          assert.equal(opened.left, 0);
          const closing = await sample(close, true);
          assert.equal(closing.position, 'fixed');
          assert.equal(closing.width, opened.width);
          assert.equal(closing.background, opened.background);
          assert.ok(closing.left < 0 && closing.right > 0, JSON.stringify(closing));
          assert.ok(closing.backdropOpacity > 0 && closing.backdropOpacity < 1);
          assert.equal(closing.inert, true);
          const closed = await sample();
          assert.ok(closed.right < 0);
          assert.equal(closed.visibility, 'hidden');
          assert.equal(closed.backdropVisibility, 'hidden');
        }
      }

      await sample('menu');
      await sample('menu', true);
      assert.equal((await sample('menu')).left, 0, 'Can reopen during closing');
      await sample('menu');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal((await sample('menu')).left, 0);
      assert.equal((await sample('menu')).visibility, 'hidden');
      await page.emulateMedia({ reducedMotion: 'no-preference' });

      await page.setViewportSize({ width: 1000, height: 800 });
      assert.equal((await sample()).width, 80);
      assert.equal((await sample('menu')).width, 280);
      const desktopClosed = await sample('menu');
      assert.equal(desktopClosed.width, 80);
      assert.equal(desktopClosed.inert, false);
      assert.equal(desktopClosed.visibility, 'visible');
      await context.close();
      console.log(`${browserType.name()}: drawer opening/closing, backdrop, reversal, reduced motion, and desktop passed.`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.close();
}
