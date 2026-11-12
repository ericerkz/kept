import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();let browser,sequence=0,owner;
const password='binder-sharing-ui-password';
async function api(path,body,token=owner,method=body===undefined?'GET':'POST',status=200) {
  const response=await fetch(fixture.origin+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal(response.status,status,await response.clone().text());return status===204?null:response.json();
}
async function binder(name,syncId,token=owner) {
  const operationId=`ui-binder-${++sequence}`;
  const response=await api('/sync/mutations',{protocolVersion:2,mutations:[{type:'binder.upsert',syncId,payload:{name},operationId,lww:{physicalMs:Date.now(),logical:sequence,deviceId:'ui',operationId}}]},token);
  assert.equal(response.results[0].ok,true,JSON.stringify(response));return response.results[0];
}
async function signIn(username,width) {
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  const session=await (await context.request.get(fixture.origin+'/api/auth/browser/session')).json();
  assert.ok((await context.request.post(fixture.origin+'/api/auth/browser/login',{data:{username,password},headers:{'X-CSRF-Token':session.csrfToken,Origin:fixture.origin}})).ok());
  await context.addInitScript(()=>localStorage.setItem('kept_notification_permission_prompt_dismissed','1'));
  const page=await context.newPage();page.setDefaultTimeout(15000);await page.goto(fixture.origin);
  await page.locator('app-sidenav').waitFor({state:'attached'});return {context,page};
}
try {
  await api('/setup/admin',{username:'owner',password},undefined,'POST',201);
  owner=(await api('/auth/login',{username:'owner',password})).token;
  await api('/users/me/mark-demo-notes-created',{});
  const recipient=await api('/users',{username:'recipient',displayName:'Recipient',password},owner,'POST',201);
  const recipientToken=(await api('/auth/login',{username:'recipient',password})).token;
  await api('/users/me/mark-demo-notes-created',{},recipientToken);
  await api('/users/me/preferences',{inheritSharedBinders:false},recipientToken,'PATCH');
  const gifts=await binder('Gifts','binder-ui-gifts');
  await binder('Gifts','binder-ui-personal',recipientToken);
  const note=await api('/notes',{noteTitle:'Parents gifts',noteBody:'A shared shopping list',binder:'Gifts',labels:[],images:[],checkBoxes:[]},owner,'POST',201);
  browser=await chromium.launch({headless:true});
  const errors=[];
  for(const width of [1280,820,390]) {
    const {context,page}=await signIn('owner',width);page.on('pageerror',error=>errors.push(error.message));
    if(width<600) await page.locator('app-navbar .pic-container').click();
    await page.getByRole('button',{name:'Edit binders',exact:true}).click();
    if(width===1280) {
      await page.getByPlaceholder('Create new binder').fill('Weekend trip');
      await page.getByPlaceholder('Create new binder').press('Enter');
      await page.getByRole('button',{name:'Share Weekend trip',exact:true}).click();
      const created=page.getByRole('dialog');
      await created.locator('label').filter({hasText:'Recipient'}).waitFor();
      await created.getByRole('button',{name:'Cancel',exact:true}).click();
      await page.getByRole('button',{name:'Edit binders',exact:true}).click();
    }
    await page.getByRole('button',{name:/^(Share|People in) Gifts$/}).click();
    const dialog=page.getByRole('dialog');await dialog.getByText('Everyone in this binder can add their own notes', {exact:false}).waitFor();
    await dialog.focus();await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.getByRole('button',{name:'Save',exact:true}).evaluate(element=>element===document.activeElement),true,'keyboard focus stays within the sharing dialog');
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('checkbox').first().evaluate(element=>element===document.activeElement),true);
    const member=dialog.locator('label').filter({hasText:'Recipient'}).getByRole('checkbox');
    if(width===1280) await member.check();
    else assert.equal(await member.isChecked(),true);
    const bounds=await dialog.boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1,JSON.stringify(bounds));
    const save=dialog.getByRole('button',{name:'Save',exact:true});
    assert.ok((await save.boundingBox()).height>=44,'touch target is usable');
    if(width===390) await page.screenshot({path:'.git/binder-sharing-mobile.png'});
    await save.click();await dialog.waitFor({state:'hidden'});
    assert.equal((await api(`/binders/${gifts.id}/members`)).members[0].id,recipient.id);
    if(width===1280) {
      await page.goto(fixture.origin+'/binder/Gifts');
      await page.locator(`app-notes [data-note-id="${note.id}"]`).click();
      await page.locator('app-input .colab:visible').first().click();
      const inherited=page.locator('.share-user:visible').filter({hasText:'Via Gifts'}).getByRole('checkbox');
      await inherited.waitFor();assert.equal(await inherited.isChecked(),true);assert.equal(await inherited.isDisabled(),true);
      assert.equal((await api(`/notes/${note.id}/collaborators`))[0].directShare,false);
    }
    await context.close();
  }

  const {context,page}=await signIn('recipient',820);page.on('pageerror',error=>errors.push(error.message));
  const received=page.locator('.received-binder').filter({hasText:'Gifts'});
  await received.waitFor();
  assert.match(await received.innerText(),/owner/i);
  assert.equal(await page.locator('.sidenav-binders .item:not(.received-binder)').filter({hasText:'Gifts'}).count(),1,'personal same-name binder remains separate');
  await received.locator('.text').click();await page.waitForURL(`**/shared-binder/${gifts.id}`);
  const card=page.locator(`app-notes [data-note-id="${note.id}"]`);await card.waitFor();
  assert.equal(await page.locator('app-input.desktop-placeholder-input').count(),1,'shared binder members can create notes using the composer');
  await context.setOffline(true);assert.match(await card.innerText(),/Parents gifts/);
  await context.setOffline(false);
  await api(`/binders/${gifts.id}/members`,{userIds:[]},owner,'PUT');
  await received.waitFor({state:'hidden'});await card.waitFor({state:'hidden'});

  await api(`/binders/${gifts.id}/members`,{userIds:[recipient.id]},owner,'PUT');
  await received.waitFor();await card.waitFor();
  await received.getByRole('button',{name:'People in Gifts',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Leave binder',exact:true}).waitFor();
  page.once('dialog',dialog=>dialog.accept());
  await dialog.getByRole('button',{name:'Leave binder',exact:true}).click();
  await page.waitForURL(fixture.origin+'/');await received.waitFor({state:'hidden'});
  assert.equal((await api(`/binders/${gifts.id}/members`)).members.length,0);
  assert.deepEqual(errors,[]);
  await context.close();
  console.log('Binder sharing UI passed at desktop/tablet/phone widths; recipient identity, offline cache, realtime revocation and leaving passed.');
} finally {await browser?.close();await fixture.close();}
