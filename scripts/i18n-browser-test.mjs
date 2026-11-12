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
  assert.deepEqual(await language.locator('option').allTextContents(),['Follow system language','English']);
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
  // Check RTL chrome independently of note content; no invented translation is shipped.
  await page.evaluate(()=>document.documentElement.dir='rtl');
  await page.locator('app-navbar .pic-container').click();
  const sidebar=page.locator('app-sidenav .main-sidebar');
  await page.waitForTimeout(350);
  const rect=await sidebar.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=391,JSON.stringify(rect));
  assert.equal(await sidebar.evaluate(element=>getComputedStyle(element).right),'0px');
  await page.setViewportSize({width:1280,height:900});
  const unchanged=await (await fetch(fixture.origin+`/api/notes/${note.id}`,{headers})).json();
  assert.equal(unchanged.noteTitle,note.noteTitle);assert.equal(unchanged.noteBody,note.noteBody,'opening/localizing must not rewrite stored content');
  assert.deepEqual(errors,[]);
  console.log('Language settings, English UI, account persistence, mixed-script notes and RTL drawer checks passed.');
  await context.close();
} finally {await browser?.close();await fixture.close();}
