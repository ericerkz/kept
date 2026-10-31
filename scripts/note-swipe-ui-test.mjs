import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Isolated headless browser: trusted touch events exercise scrolling and the
// production gesture handlers without opening or controlling a desktop browser.
const fixture = await startFixture();
let browser;
try {
  const credentials = {username:'swipe-owner',password:'isolated-swipe-test-password'};
  let token;
  async function api(path,body,method=body?'POST':'GET') {
    const response=await fetch(fixture.origin+'/api'+path,{method,
      headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
      body:body?JSON.stringify(body):undefined});
    assert.ok(response.ok,await response.clone().text());
    return response.status===204?null:response.json();
  }
  async function waitForArchived(noteId, archived) {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      if((await api(`/notes/${noteId}`)).archived===archived)return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal((await api(`/notes/${noteId}`)).archived,archived,'queued archive state reaches the server');
  }
  await api('/setup/admin',credentials);
  token=(await api('/auth/login',credentials)).token;
  await api('/users/me/mark-demo-notes-created',{});
  const notes=[];
  for(let index=0;index<20;index++) notes.push(await api('/notes',{
    noteTitle:`Swipe check ${index}`,noteBody:'A note with enough text to make vertical scrolling meaningful. '.repeat(15),
    bgColor:'',bgImage:'',labels:[],images:[],checkBoxes:[]
  }));
  browser=await chromium.launch({headless:true});
  for(const width of [390,1000]) {
    const context=await browser.newContext({viewport:{width,height:800},hasTouch:true,isMobile:width<768,serviceWorkers:'block'});
    const session=await(await context.request.get(fixture.origin+'/api/auth/browser/session')).json();
    assert.ok((await context.request.post(fixture.origin+'/api/auth/browser/login',{
      data:credentials,headers:{'X-CSRF-Token':session.csrfToken,Origin:fixture.origin}
    })).ok());
    await context.addInitScript(()=>localStorage.setItem('kept_notification_permission_prompt_dismissed','1'));
    const page=await context.newPage();page.setDefaultTimeout(10000);
    await page.goto(fixture.origin);
    const note=notes.at(-1),card=page.locator(`app-notes [data-note-id="${note.id}"]`);
    await card.waitFor();await page.waitForTimeout(300);
    const client=await context.newCDPSession(page);
    const start=async(x,y)=>client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
    const move=async(x,y)=>client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y,id:1}]});
    const end=async()=>client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const gesture=async(dx,dy=0,commit=true)=>{
      const box=await card.boundingBox(),x=box.x+box.width/2,y=box.y+Math.min(80,box.height/2);
      await start(x,y);
      for(let step=1;step<=6;step++){await move(x+dx*step/6,y+dy*step/6);await page.waitForTimeout(20);}
      if(!commit)return{x,y};
      await end();
    };
    // Partial swipe springs back without archiving or opening the editor.
    await gesture(35);assert.equal((await api(`/notes/${note.id}`)).archived,false);
    assert.equal(await page.locator('app-notes > .modal-container').evaluate(el=>el.style.display),'');
    // Both directions commit on release, with the real Undo restoring the note.
    for(const dx of [-130,130]) {
      await gesture(dx,0,false);
      await page.locator(`[data-note-id="${note.id}"].note-swipe-ready`).waitFor();
      if(width===390&&dx>0&&process.env.KEPT_SWIPE_SCREENSHOT)await page.screenshot({path:process.env.KEPT_SWIPE_SCREENSHOT});
      assert.equal((await api(`/notes/${note.id}`)).archived,false,'moving alone must not archive');
      await end();await card.waitFor({state:'hidden'});
      await waitForArchived(note.id,true);
      await page.getByText('Undo',{exact:true}).last().click();
      await card.waitFor();
      await waitForArchived(note.id,false);
      await page.waitForTimeout(400); // Let masonry's restoration transition settle before the next gesture.
    }
    // Holding still retains multi-selection rather than triggering an archive.
    let box=await card.boundingBox();await start(box.x+box.width/2,box.y+40);
    await page.locator('.touch-dragging-ghost').waitFor();await end();
    await page.locator(`[data-note-id="${note.id}"].selected`).waitFor();
    await page.getByRole('button',{name:'Clear selection',exact:true}).click();
    assert.equal((await api(`/notes/${note.id}`)).archived,false);
    if(width===390) {
      await page.evaluate(()=>scrollTo(0,0));await gesture(3,-140);
      assert.ok(await page.evaluate(()=>scrollY)>0,'vertical gestures still scroll');
      assert.equal((await api(`/notes/${note.id}`)).archived,false);
    } else {
      box=await card.boundingBox();await page.mouse.move(box.x+80,box.y+50);await page.mouse.down();
      await page.mouse.move(box.x+160,box.y+50,{steps:8});await page.mouse.up();
      await page.mouse.wheel(180,0);
      assert.equal((await api(`/notes/${note.id}`)).archived,false,'mouse and trackpad input never archive');
    }
    assert.equal(await page.locator('.note-swiping').count(),0);
    console.log(`Touch archive, Undo, long press and input separation passed at ${width}px.`);
    await context.close();
  }
} finally {await browser?.close();await fixture.close();}
