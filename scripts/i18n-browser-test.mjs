import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startFixture} from '../test-support/session-fixture.cjs';

const fixture=await startFixture();let browser;
try {
  const credentials={username:'language-ui',password:'test-language-ui-password'};
  assert.equal((await fetch(fixture.origin+'/api/setup/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)})).status,201);
  const login=await (await fetch(fixture.origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)})).json();
  const headers={'Content-Type':'application/json',Authorization:`Bearer ${login.token}`};
  const noteBody='<h2>שלום עולם</h2><p>טקסט בעברית</p><p>English paragraph remains readable.</p>';
  const note=await (await fetch(fixture.origin+'/api/notes',{method:'POST',headers,body:JSON.stringify({noteTitle:'Mixed Hebrew and English',noteBody})})).json();
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.addInitScript(()=>localStorage.setItem('kept_notification_permission_prompt_dismissed','1'));
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(fixture.origin+'/login');
  await page.getByLabel('Username',{exact:true}).fill(credentials.username);
  await page.getByLabel('Password',{exact:true}).fill(credentials.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForURL(fixture.origin+'/');await page.locator('app-notes').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('html').getAttribute('dir'),'ltr');
  assert.equal(await page.locator('[placeholder="Search your notes"]').count(),1);
  const card=page.locator('.note-container').filter({hasText:'Mixed Hebrew and English'}).first();await card.waitFor();
  assert.equal(await card.locator('.title').getAttribute('dir'),'auto');
  assert.equal(await card.locator('.body h2').evaluate(element=>getComputedStyle(element).unicodeBidi),'plaintext');
  await card.click();
  const title=page.locator('.note-title[contenteditable]:visible').first();await title.waitFor();
  assert.equal(await title.getAttribute('dir'),'auto');
  const body=page.locator('.note-body[contenteditable]:visible').first();
  assert.equal(await body.getAttribute('dir'),'auto');
  assert.match(await body.textContent(),/שלום עולם/);
  await page.goto(fixture.origin+'/settings');
  const language=page.locator('#interface-language');await language.waitFor();
  assert.ok((await language.locator('option').allTextContents()).includes('English'));
  await language.selectOption('en');
  try { await page.waitForFunction(()=>JSON.parse(localStorage.getItem('gk_session')).language==='en'); }
  catch(error) { console.error(await page.evaluate(()=>({session:localStorage.getItem('gk_session'),selection:document.querySelector('#interface-language')?.value,text:document.querySelector('app-settings')?.textContent})));throw error; }
  for (let attempt=0; attempt<60; attempt++) {
    if ((await (await fetch(fixture.origin+'/api/users/me/preferences',{headers})).json()).language === 'en') break;
    await page.waitForTimeout(100);
  }
  assert.equal((await (await fetch(fixture.origin+'/api/users/me/preferences',{headers})).json()).language,'en');
  await page.reload();await language.waitFor();assert.equal(await language.inputValue(),'en');
  await page.goto(fixture.origin+'/');await page.locator('app-notes').waitFor();
  // Hebrew translates text without mirroring the app's layout.
  await page.goto(fixture.origin+'/settings');
  await language.waitFor();await language.selectOption('he');
  await page.waitForFunction(()=>document.documentElement.lang==='he');
  assert.equal(await page.locator('html').getAttribute('dir'),'ltr');
  await page.goto(fixture.origin+'/');await page.locator('app-notes').waitFor();
  const search=page.locator('app-navbar input:visible').first();
  const heading=await page.locator('app-notes [_title]').first().evaluate(element=>{
    const range=document.createRange();range.selectNodeContents(element);
    return {textLeft:range.getBoundingClientRect().left,boxLeft:element.getBoundingClientRect().left};
  });
  assert.ok(Math.abs(heading.textLeft-heading.boxLeft)<2,JSON.stringify(heading));
  assert.equal(await search.evaluate(element=>getComputedStyle(element).textAlign),'left','Hebrew search placeholder stays beside its icon');
  await page.setViewportSize({width:1280,height:900});
  await page.waitForTimeout(500);
  assert.equal(await page.locator('app-notes [_title]').first().evaluate(element=>getComputedStyle(element).textAlign),'left');
  const starter=page.locator('app-input .placeholder .input:visible');
  assert.equal(await starter.evaluate(element=>getComputedStyle(element).textAlign),'left');
  const starterSpace=await starter.evaluate(element=>{
    const rect=element.getBoundingClientRect();
    return rect.right-parseFloat(getComputedStyle(element).paddingRight);
  });
  const firstAction=await page.locator('app-input .placeholder .check:visible').boundingBox();
  assert.ok(starterSpace <= firstAction.x,'starter placeholder must not run beneath quick-create icons');
  await starter.click();
  const draftTitle=page.locator('app-input .note-title[contenteditable]:visible').first();
  await draftTitle.waitFor();
  assert.equal(await page.locator('app-input .note-title.ph:visible').evaluate(element=>getComputedStyle(element).textAlign),'left');
  await draftTitle.fill('כותרת בעברית');
  assert.equal(await draftTitle.evaluate(element=>getComputedStyle(element).direction),'rtl','typed Hebrew retains its text direction');
  const titleRight=await draftTitle.evaluate(element=>element.getBoundingClientRect().right-parseFloat(getComputedStyle(element).paddingRight));
  const pin=await page.locator('app-input .note-main:visible > .pin-icon:visible').boundingBox();
  assert.ok(titleRight <= pin.x,'RTL title must stop before the pin');
  if (process.env.KEPT_I18N_SCREENSHOT) await page.screenshot({path:process.env.KEPT_I18N_SCREENSHOT});
  await page.locator('app-input .close-btn:visible').click();
  await page.setViewportSize({width:390,height:844});
  await page.locator('app-navbar .pic-container').click();
  const sidebar=page.locator('app-sidenav .main-sidebar');
  await page.waitForTimeout(350);
  const rect=await sidebar.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=391,JSON.stringify(rect));
  assert.ok((await sidebar.boundingBox()).x <= 16,'sidebar stays on the left');
  await page.setViewportSize({width:1280,height:900});
  assert.equal(await page.locator('app-navbar').evaluate(element=>getComputedStyle(element).direction),'ltr');
  assert.equal(await page.locator('app-notes .main-container').evaluate(element=>getComputedStyle(element).direction),'ltr');
  assert.ok((await sidebar.boundingBox()).x <= 16,'sidebar stays on the left');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'translated layout must fit the viewport');
  const unchanged=await (await fetch(fixture.origin+`/api/notes/${note.id}`,{headers})).json();
  assert.equal(unchanged.noteTitle,note.noteTitle);assert.equal(unchanged.noteBody,note.noteBody,'opening/localizing must not rewrite stored content');
  assert.deepEqual(errors,[]);
  console.log('Language settings, English UI, account persistence, mixed-script notes and stable Hebrew layout checks passed.');
  await context.close();
} finally {await browser?.close();await fixture.close();}
