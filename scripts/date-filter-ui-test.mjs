import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'date-filter', password: 'test-date-filter-password' };
  assert.equal((await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).status, 201);
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({serviceWorkers:'block'});
  const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
  assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
    data:credentials, headers:{'X-CSRF-Token':session.csrfToken, Origin:fixture.origin}
  })).ok());
  await context.addInitScript(() => localStorage.setItem('kept_notification_permission_prompt_dismissed','1'));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(fixture.origin);
  const search = page.locator('app-navbar .search-row input').first();
  const panel = page.locator('.filters-dropdown');
  const date = panel.getByRole('checkbox', {name:'Date',exact:true});
  for (const width of [1280,390]) {
    await page.setViewportSize({width,height:844});
    for (const theme of ['light-theme','dark-theme']) {
      await page.evaluate(theme => {document.body.classList.remove('light-theme','dark-theme');document.body.classList.add(theme);},theme);
      await search.fill('!url');await search.blur();
      await page.locator('app-navbar .filters-btn').click();
      assert.equal(await date.getAttribute('aria-checked'),'false');
      assert.equal(await panel.locator('.date-filter-examples').count(),0);
      await date.click();
      await panel.waitFor({state:'visible'});
      assert.equal(await search.inputValue(),'!url !date ');
      assert.equal(await date.getAttribute('aria-checked'),'true');
      assert.deepEqual(await panel.locator('.date-filter-examples button').allTextContents(),['today','november','2025']);
      assert.equal(await panel.getByText('Active labels',{exact:true}).count(),0);
      const november=panel.getByRole('button',{name:'Filter by creation date: november',exact:true});
      await november.click();
      assert.equal(await search.inputValue(),'!url !date november');
      assert.equal(await november.getAttribute('aria-pressed'),'true');
      assert.equal(await panel.isVisible(),true);
      assert.equal(await search.evaluate(input=>document.activeElement===input && input.selectionStart===input.value.length),true);
      await panel.getByRole('button',{name:'Filter by creation date: 2025',exact:true}).click();
      assert.equal(await search.inputValue(),'!url !date 2025','example replaces the previous operand');
      await date.click();
      assert.equal(await search.inputValue(),'!url');
      assert.equal(await panel.locator('.date-filter-examples').count(),0);
      await search.fill('budget !url !date November 2025');
      assert.equal(await date.getAttribute('aria-checked'),'true');
      await date.click();
      assert.equal(await search.inputValue(),'budget !url','unchecking removes a manually entered multiword date');
      const bounds=await panel.boundingBox();
      assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width,JSON.stringify(bounds));
      assert.ok(bounds.y>=0 && bounds.y+bounds.height<=844,JSON.stringify(bounds));
      if (process.env.KEPT_DATE_FILTER_SCREENSHOT && width===1280 && theme==='light-theme') {
        await date.click();await november.click();
        await page.screenshot({path:process.env.KEPT_DATE_FILTER_SCREENSHOT});
      }
      await panel.getByText('Clear All',{exact:true}).click();
      assert.equal(await search.inputValue(),'budget');
      assert.equal(await panel.count(),0);
    }
  }
  console.log('PASS: Date checkbox, clickable examples, query/caret preservation, custom dates and Clear All in desktop/phone layouts and both themes.');
} finally {await browser?.close();await fixture.close();}
