import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import AdmZip from 'adm-zip';
import { chromium, webkit } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Use synthetic Takeout data by default. A private archive may be supplied for
// local verification; its contents never become fixtures or console output.
const fixture = await startFixture({ env: { KEPT_LINK_PREVIEW_SCREENSHOTS: '0' } });
let browser;
try {
  const credentials = { username: 'grid-owner', password: 'test-grid-owner-password' };
  await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  const login = await (await fetch(fixture.origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).json();
  const headers = { Authorization: 'Bearer ' + login.token };
  await fetch(fixture.origin + '/api/users/me/mark-demo-notes-created', { method: 'POST', headers });
  login.user.demoNotesCreatedAt = new Date().toISOString();
  let archive;
  if (process.env.KEPT_GRID_TAKEOUT) archive = await readFile(process.env.KEPT_GRID_TAKEOUT);
  else {
    const zip = new AdmZip();
    for (let i = 0; i < 300; i++) {
      zip.addFile(`Takeout/Keep/note-${i}.json`, Buffer.from(JSON.stringify({
        title: `Grid note ${i}`, textContent: 'A short note.\n'.repeat(i % 5 + 1),
        isPinned: i < 9, isArchived: false, isTrashed: false,
        createdTimestampUsec: String(1700000000000000 + i * 1000000),
        userEditedTimestampUsec: String(1700000000000000 + i * 1000000)
      })));
    }
    archive = zip.toBuffer();
  }
  const data = new FormData();
  data.append('takeout', new Blob([archive], { type: 'application/zip' }), 'takeout.zip');
  const imported = await fetch(fixture.origin + '/api/import/google-takeout', { method: 'POST', headers, body: data });
  assert.equal(imported.status, 200);
  const result = await imported.json();
  assert.ok(result.imported > 160, 'library must exercise the Load more control');
  assert.equal(result.errors, 0);
  const before = await fixture.sql('SELECT id, syncId, noteTitle, noteBody, updatedAt FROM notes ORDER BY id');

  const engine = process.env.KEPT_TEST_BROWSER === 'webkit' ? webkit : chromium;
  browser = await engine.launch();
  const context = await browser.newContext({
    viewport: { width: 669, height: 978 }, screen: { width: 669, height: 978 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    isMobile: true, hasTouch: true, serviceWorkers: 'block'
  });
  await context.addInitScript(({ token, user }) => {
    window.CapacitorCustomPlatform = { name: 'ios' };
    localStorage.setItem('gk_session', JSON.stringify({ ...user, token }));
    localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
  }, login);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Layout checks need no requests to sites mentioned in imported notes.
  await page.route('**/api/link-preview**', route => route.fulfill({ json: {} }));
  await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.note-container:visible').first().waitFor();
  const more = page.getByRole('button', { name: 'Load more', exact: true }).last();
  await more.waitFor({ state: 'attached' });
  const checkGrid = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('.notes-layout')]
      .filter(grid => grid.offsetWidth).every(grid => grid.children.length >= 3));
    await page.waitForTimeout(500);
    await page.waitForFunction(() => !document.getAnimations().some(animation =>
      animation.playState === 'running' && animation.effect?.target?.classList?.contains('note-container')));
    // Late image measurements and the movement transition can settle after
    // rotation; verify the final layout rather than a frame in that animation.
    for (let attempt = 0; ; attempt++) {
      try {
        const grids = await page.locator('.notes-layout:visible').evaluateAll(nodes => nodes.map(grid => {
          const bounds = grid.getBoundingClientRect();
          const cards = [...grid.children];
          return {
            x: bounds.x, right: bounds.right, width: bounds.width,
            onlyCards: cards.every(card => card.classList.contains('note-container')),
            cards: cards.map(card => {
              const rect = card.getBoundingClientRect();
              return { x: rect.x, right: rect.right, width: rect.width };
            })
          };
        }));
        const viewport = await page.evaluate(() => innerWidth);
        for (const grid of grids) {
          assert.equal(grid.onlyCards, true, 'pagination controls must never be packed as cards');
          assert.ok(grid.x >= 0 && grid.right <= viewport, JSON.stringify({ viewport, grid }));
          for (const card of grid.cards) {
            assert.ok(card.x >= grid.x - 1 && card.right <= grid.right + 1,
              JSON.stringify({ viewport, gridWidth: grid.width, card }));
          }
          const columns = [...new Set(grid.cards.map(card => Math.round(card.x)))];
          assert.equal(columns.length, 3, `foldable must display three distinct, fully visible columns: ${JSON.stringify({ viewport, width: grid.width, cards: grid.cards.slice(0, 3) })}`);
        }
        assert.equal(await more.evaluate(button => button.closest('.notes-layout') === null
          && getComputedStyle(button).position === 'static'
          && button.getBoundingClientRect().top >= button.previousElementSibling.getBoundingClientRect().bottom - 1), true,
          'Load more stays below the grid in normal flow');
        break;
      } catch (error) {
        if (attempt === 30) throw error;
        await page.waitForTimeout(200);
      }
    }
  };
  for (const viewport of [{ width: 669, height: 978 }, { width: 978, height: 669 }, { width: 678, height: 466 }]) {
    await page.setViewportSize(viewport);
    await checkGrid();
  }
  const visibleBefore = await page.locator('.note-container:visible').count();
  // Invoke the button without scrolling it into view: scrolling near the end
  // deliberately triggers automatic pagination and can remove the button first.
  await more.evaluate(button => button.click());
  await page.waitForFunction(count => document.querySelectorAll('.notes-layout .note-container').length > count, visibleBefore);
  await checkGrid();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.note-container:visible').first().waitFor();
  await more.waitFor({ state: 'attached' });
  await checkGrid();
  if (process.env.KEPT_GRID_SCREENSHOT) await page.screenshot({ path: process.env.KEPT_GRID_SCREENSHOT });
  assert.equal(JSON.stringify(await fixture.sql('SELECT id, syncId, noteTitle, noteBody, updatedAt FROM notes ORDER BY id')) === JSON.stringify(before), true,
    'loading, rotating and paginating must not change imported notes');
  assert.deepEqual(errors, []);
  console.log(`PASS (${engine.name()}): large Takeout library grid, foldable portrait/landscape/rotation, Load more, reload and unchanged notes`);
} finally {
  await browser?.close();
  await fixture.close();
}
