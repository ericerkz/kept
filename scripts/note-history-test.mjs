import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startFixture} from '../test-support/session-fixture.cjs';
const fixture=await startFixture();let browser;
try {
 const credentials={username:'owner',displayName:'Owner',password:'test-password-123'};
 let token;
 async function api(path,data,method=data?'POST':'GET'){
  const response=await fetch(fixture.origin+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});
  assert.ok(response.ok,await response.clone().text());return response.json();
 }
 await api('/setup/admin',credentials);const login=await api('/auth/login',credentials);token=login.token;
 await api('/users/me/mark-demo-notes-created',{});
 const label=await api('/labels',{name:'History'});
 const note=await api('/notes',{noteTitle:'History target',noteBody:'Original body',pinned:false,bgColor:'',labels:[{...label,added:true}],images:[],checkBoxes:[]});
 for(let i=0;i<24;i++)await api('/notes',{noteTitle:`Filler ${i}`,noteBody:'A few lines of text. '.repeat(40),pinned:false,bgColor:'',labels:[{...label,added:true}],images:[],checkBoxes:[]});
 browser=await chromium.launch({headless:true});
 for(const mobile of [false,true]) {
  assert.ok((await api(`/notes/${note.id}`)).labels.some(item=>item.name==='History'),'saving and direct URLs preserve the note Label');
  const context=await browser.newContext({serviceWorkers:'block',viewport:mobile?{width:390,height:844}:{width:1440,height:900}});
  const session=await(await context.request.get(fixture.origin+'/api/auth/browser/session')).json();
  const signedIn=await context.request.post(fixture.origin+'/api/auth/browser/login',{data:credentials,headers:{'X-CSRF-Token':session.csrfToken,Origin:fixture.origin}});assert.ok(signedIn.ok(),await signedIn.text());
  await context.addInitScript(user=>{localStorage.setItem('gk_session',JSON.stringify({...user,demoNotesCreatedAt:new Date().toISOString()}));localStorage.setItem('kept_notification_permission_prompt_dismissed','1');},login.user);
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/previous-page',route=>route.fulfill({contentType:'text/html',body:'<h1>Previous website</h1>'}));
  await page.goto(fixture.origin+'/previous-page');
  const base='/label/History?keep=1';await page.goto(fixture.origin+base);
  await page.locator('app-notes .note-container').first().waitFor();
  await page.evaluate(()=>{scrollTo(0,document.documentElement.scrollHeight);dispatchEvent(new Event('scroll'));});
  const target=page.locator(`app-notes .note-container[data-note-id="${note.id}"]`);await target.waitFor();await target.scrollIntoViewIfNeeded();
  const scroll=await page.evaluate(()=>scrollY);
  await target.getByText(note.noteTitle,{exact:true}).click();
  const editor=page.locator('app-notes .modal app-input');
  await page.waitForURL(url=>url.searchParams.get('note')===String(note.id));
  assert.equal(new URL(page.url()).pathname,'/label/History');assert.equal(new URL(page.url()).searchParams.get('keep'),'1');
  const body=`Immediate edit ${mobile?'PWA':'desktop'}`;await editor.locator('.note-body[contenteditable]').fill(body);
  await page.goBack();await editor.waitFor({state:'hidden'});assert.equal(new URL(page.url()).pathname+new URL(page.url()).search,base);
  await page.waitForFunction(y=>Math.abs(scrollY-Math.min(y,Math.max(0,document.documentElement.scrollHeight-innerHeight)))<3,scroll);
  // Forward reopens the note; refreshing that URL keeps it open.
  await page.goForward();await editor.locator('.note-body[contenteditable]').waitFor();assert.equal(await editor.locator('.note-body[contenteditable]').innerText(),body);
  await page.reload({waitUntil:'domcontentloaded'});await editor.locator('.note-body[contenteditable]').waitFor();
  assert.equal(await editor.locator('.note-body[contenteditable]').innerText(),body);
  await editor.locator('.close-btn:visible,.mobile-icon.back:visible').first().click();await editor.waitFor({state:'hidden'});
  assert.equal(new URL(page.url()).searchParams.has('note'),false);
  await page.goBack();await page.getByRole('heading',{name:'Previous website'}).waitFor();
  // A directly entered URL synthesizes a grid entry, so Back still closes the editor.
  await page.goto(fixture.origin+`/?note=${note.id}`);await editor.locator('.note-body[contenteditable]').waitFor();
  await page.goBack();await editor.waitFor({state:'hidden'});assert.equal(new URL(page.url()).pathname,'/');
  // A failed local write keeps the editor and unsaved text available.
  await page.locator(`app-notes .note-container[data-note-id="${note.id}"]`).getByText(note.noteTitle,{exact:true}).click();
  await page.waitForURL(url=>url.searchParams.has('note'));
  await page.evaluate(()=>{
   window.keptOriginalTransaction=IDBDatabase.prototype.transaction;
   IDBDatabase.prototype.transaction=function(...args){const tx=window.keptOriginalTransaction.apply(this,args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
  });
  await editor.locator('.note-body[contenteditable]').fill('Keep this unsaved edit');await page.goBack();
  await page.waitForURL(url=>url.searchParams.get('note')===String(note.id));
  assert.equal(await editor.locator('.note-body[contenteditable]').innerText(),'Keep this unsaved edit');
  await page.evaluate(()=>{IDBDatabase.prototype.transaction=window.keptOriginalTransaction;});
  await page.goBack();await editor.waitFor({state:'hidden'});
  // Missing notes fail back to the grid without a navigation loop.
  await page.goto(fixture.origin+'/?note=999999');await page.waitForURL(url=>!url.searchParams.has('note'));
  assert.deepEqual(errors,[]);
  console.log(`PASS ${mobile?'PWA phone':'desktop web'}: Back/save/scroll, Forward, Close, refresh/direct URL, failed writes and missing notes`);
  await context.close();
 }
 for(const platform of ['ios','android']) {
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  await context.addInitScript(name=>{
   window.CapacitorCustomPlatform={name};localStorage.setItem('kept_notification_permission_prompt_dismissed','1');
   if(name==='android'){
    window.keptAppListeners={};window.keptExitCount=0;
    window.Capacitor={PluginHeaders:[{name:'App',methods:[{name:'addListener',rtype:'callback'},{name:'removeListener',rtype:'promise'},{name:'exitApp',rtype:'promise'}]}],
     nativeCallback:(_plugin,_method,options,callback)=>{(window.keptAppListeners[options.eventName]||=[]).push(callback);return String(window.keptAppListeners[options.eventName].length);},
     nativePromise:async(_plugin,method)=>{if(method==='exitApp')window.keptExitCount++;return{};}};
   }
  },platform);
  const page=await context.newPage();page.setDefaultTimeout(10000);const calls=[];page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))calls.push(request.url());});
  await page.goto(fixture.origin);await page.getByRole('button',{name:'Use on this device',exact:true}).click();await page.locator('app-notes').waitFor();
  await page.getByRole('button',{name:'New note',exact:true}).click();
  const composing=page.locator('app-input .note-main:visible').first();
  await composing.getByRole('textbox',{name:'Title',exact:true}).fill('Local history');await composing.locator('.note-body[contenteditable]').fill('Offline body');
  await composing.locator('.close-btn:visible,.mobile-icon.back:visible').first().click();
  await page.locator('app-input.mobile-active').waitFor({state:'hidden'});
  await page.locator('app-notes .note-container').getByText('Local history',{exact:true}).click();
  const editor=page.locator('app-notes .modal app-input');await page.waitForURL(url=>url.searchParams.has('note'));
  await editor.locator('.note-body[contenteditable]').fill('Local edit survives Back');
  if(platform==='android'){
   await page.waitForFunction(()=>window.keptAppListeners?.backButton?.length);
   await page.evaluate(()=>window.keptAppListeners.backButton.forEach(callback=>callback({canGoBack:true})));
  }else await page.goBack();
  await editor.waitFor({state:'hidden'});await page.waitForURL(url=>!url.searchParams.has('note'));
  await page.goForward();await editor.locator('.note-body[contenteditable]').waitFor();
  assert.equal(await editor.locator('.note-body[contenteditable]').innerText(),'Local edit survives Back');
  await page.reload();await editor.locator('.note-body[contenteditable]').waitFor();
  assert.equal(await editor.locator('.note-body[contenteditable]').innerText(),'Local edit survives Back');
  assert.deepEqual(calls,[]);if(platform==='android')assert.equal(await page.evaluate(()=>window.keptExitCount),0);
  console.log(`PASS ${platform} local emulation: Back saves offline, Forward/reload reopen correctly${platform==='android'?', native Back consumes one entry':''}`);
  await context.close();
 }
}finally{await browser?.close();await fixture.close();}
