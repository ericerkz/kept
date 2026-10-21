import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startFixture} from '../test-support/session-fixture.cjs';

const fixture=await startFixture();let browser;
const credentials={username:'map-owner',displayName:'Owner',password:'test-password-123'};let token;
async function api(path,data,method=data?'POST':'GET') {
 const response=await fetch(fixture.origin+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});
 assert.ok(response.ok,await response.clone().text());return response.status===204?null:response.json();
}
async function resources(page,store) {
 return page.evaluate(name=>new Promise((resolve,reject)=>{
  const open=indexedDB.open('kept-offline-v1');open.onerror=()=>reject(open.error);open.onsuccess=()=>{
   const db=open.result,request=db.transaction(name).objectStore(name).getAll();request.onerror=()=>reject(request.error);request.onsuccess=()=>{resolve(request.result.map(row=>row.value));db.close();};
  };
 }),store);
}
try {
 await api('/setup/admin',credentials);const login=await api('/auth/login',credentials);token=login.token;
 await api('/users/me/mark-demo-notes-created',{});
 browser=await chromium.launch({headless:true});
 for(const platform of ['ios','android']) for(const local of [true,false]) {
  const title=`Map ${platform} ${local?'local':'server'}`,placeName=`Trail gate ${platform} ${local?'local':'server'}`;
  if(!local)await api('/notes',{noteTitle:title,noteBody:'Pin test',labels:[],images:[],checkBoxes:[]});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  await context.addInitScript(({platform,session})=>{
   window.CapacitorCustomPlatform={name:platform};window.mapNativeCalls=[];window.mapForeground=false;
   window.mapGeo={latitude:43.65,longitude:-79.38};window.mapGeoDenied=false;
   localStorage.setItem('kept_notification_permission_prompt_dismissed','1');
   if(session)localStorage.setItem('gk_session',JSON.stringify(session));
   Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(success,error){if(window.mapGeoDenied)error({code:1});else success({coords:window.mapGeo});}}});
   const permission=()=>({foregroundGranted:window.mapForeground,backgroundGranted:true,status:'granted'});
   const resolve=async()=>{if(window.mapDelaySearch)await new Promise(done=>window.mapReleaseSearch=done);return{status:'resolved',location:{displayName:'Search result',latitude:40.7,longitude:-74,radiusMeters:120,source:'geocoder',confidence:'high'}};};
   const workspaceMethods=['getCapabilities','activateWorkspace','publishSnapshot','listActions','acknowledgeActions','quarantineActions','syncReminders','cancelReminders','requestRemindersPermission'];
   const geofenceMethods=['getPermissionStatus','requestForegroundLocationPermission','getNotificationPermissionStatus','getPendingTriggeredEvents','syncGeofences','resolveLocation','locationMapPreview'];
   window.Capacitor={Plugins:{KeptIntelligence:{resolveLocation:resolve}},PluginHeaders:[{name:'KeptWorkspace',methods:workspaceMethods.map(name=>({name,rtype:'promise'}))},{name:'KeptGeofence',methods:geofenceMethods.map(name=>({name,rtype:'promise'}))}],
    nativePromise:async(plugin,method,options)=>{
     window.mapNativeCalls.push({plugin,method,options});
     if(method==='getCapabilities')return{version:1,durableActions:true,workspaceSnapshots:true,streamingFiles:false,androidRecurringReminders:true};
     if(method==='listActions')return{actions:[]};
     if(method==='requestRemindersPermission')return{granted:true};
     if(method==='getPermissionStatus')return permission();
     if(method==='requestForegroundLocationPermission'){window.mapForeground=true;return permission();}
     if(method==='getNotificationPermissionStatus')return{granted:true,status:'granted'};
     if(method==='getPendingTriggeredEvents')return{events:[]};
     if(method==='resolveLocation')return resolve();
     if(method==='locationMapPreview')return{};
     return{};
    }};
  },{platform,session:local?null:{...login.user,token,demoNotesCreatedAt:new Date().toISOString()}});
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  let failTiles=false;const zooms=[];
  await page.route('https://tile.openstreetmap.org/**',route=>{
   zooms.push(Number(new URL(route.request().url()).pathname.split('/')[1]));
   return failTiles?route.abort():route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=','base64')});
  });
  await page.goto(fixture.origin);
  if(local) {
   await page.getByRole('button',{name:'Use on this device',exact:true}).click();await page.locator('app-notes').waitFor();
   await page.getByRole('button',{name:'New note',exact:true}).click();const input=page.locator('app-input .note-main:visible').first();
   await input.getByRole('textbox',{name:'Title',exact:true}).fill(title);await input.locator('.note-body[contenteditable]').fill('Pin test');
   await input.locator('.mobile-icon.back:visible,.close-btn:visible').first().click();
  }
  await page.locator('app-notes .note-container').getByText(title,{exact:true}).click();
  const editor=page.locator('app-notes .modal app-input');
  const openPlaces=async()=>{await editor.locator('.mobile-icon.alarm:visible,.alarm[data-pop]:visible').first().click();await page.locator('.rd-choice-card').filter({has:page.getByText('Place',{exact:true})}).click();};
  await openPlaces();const dialog=page.getByRole('dialog',{name:'Set location reminder',exact:true});
  await dialog.getByRole('button',{name:'Choose on map',exact:true}).click();const picker=dialog.locator('app-location-map-picker');
  await picker.locator('.leaflet-container').waitFor();
  const bounds=await dialog.boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=845,'map dialog stays inside the phone viewport');
  await picker.getByRole('button',{name:'Use my current location',exact:true}).click();
  if(platform==='android')await page.getByRole('button',{name:'Allow location reminders',exact:true}).click();
  await picker.getByText('43.65000, -79.38000',{exact:true}).waitFor();
  // A real drag changes the selected coordinates, and native touch pinch changes zoom.
  const map=picker.locator('.map-canvas'),box=await map.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2+25,{steps:8});await page.mouse.up();
  await page.waitForFunction(()=>!document.querySelector('.map-coordinates')?.textContent.includes('43.65000, -79.38000'));
  const beforeZoom=Math.max(...zooms),cdp=await context.newCDPSession(page),x=box.x+box.width/2,y=box.y+box.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-25,y},{x:x+25,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-65,y},{x:x+65,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>!document.querySelector('.leaflet-zoom-anim'));
  await picker.getByRole('button',{name:'250 m',exact:true}).click();
  const coordinates=(await picker.locator('.map-coordinates').innerText()).split(', ').map(Number);
  await picker.getByRole('button',{name:'Use this location',exact:true}).click();
  await dialog.locator('input[name="mapPinName"]').fill('Parking spot');
  await dialog.getByRole('button',{name:/Remind me when I/}).click();
  await dialog.getByRole('button',{name:'Set reminder',exact:true}).click();
  await editor.locator('.reminder-chip').filter({hasText:'Parking spot'}).waitFor();
  await page.waitForFunction(()=>window.mapNativeCalls.some(call=>call.method==='syncReminders'&&call.options.reminders.some(row=>row.locationName==='Parking spot')));
  const reminder=(await resources(page,'reminders')).find(row=>row.locationName==='Parking spot');
  assert.ok(reminder);assert.equal(reminder.radiusMeters,250);assert.equal(reminder.locationTrigger,'leave');
  assert.ok(Math.abs(reminder.latitude-coordinates[0])<.00001);assert.ok(Math.abs(reminder.longitude-coordinates[1])<.00001);
  await page.waitForFunction(id=>window.mapNativeCalls.some(call=>call.method==='syncReminders'&&call.options.reminders.some(row=>row.syncId===id&&row.radiusMeters===250)),reminder.syncId);
  if(!local) {await page.waitForFunction(()=>document.querySelector('.offline-sync-state')===null);assert.ok((await api('/reminders')).some(row=>row.locationName==='Parking spot'&&row.radiusMeters===250));}
  await editor.locator('.reminder-chip').click();await editor.getByRole('button',{name:'Remove reminder',exact:true}).click();
  await editor.locator('.reminder-chip').waitFor({state:'hidden'});
  await openPlaces();await dialog.getByRole('button',{name:/Add saved place/}).click();
  await dialog.locator('input[name="addPlaceName"]').fill(placeName);await dialog.getByRole('button',{name:'Choose on map',exact:true}).click();
  // Denied GPS and failed tiles leave manual selection usable; cancelling does not save.
  await page.evaluate(()=>{window.mapGeoDenied=true;});await picker.getByRole('button',{name:'Use my current location',exact:true}).click();
  await picker.getByText(/Could not get your location/).waitFor();
  await dialog.locator('input[name="locationPhrase"]').fill('Search result');await dialog.locator('input[name="locationPhrase"]').press('Enter');
  await picker.getByText('40.70000, -74.00000',{exact:true}).waitFor();
  await picker.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await resources(page,'savedPlaces')).some(row=>row.name===placeName),false);
  failTiles=true;await dialog.getByRole('button',{name:/^(Choose on map|Adjust pin on map)$/}).click();
  await page.evaluate(()=>{window.mapGeoDenied=false;window.mapGeo={latitude:1.23456,longitude:2.34567};});
  await picker.getByRole('button',{name:'Use my current location',exact:true}).click();await picker.getByText('1.23456, 2.34567',{exact:true}).waitFor();
  // Move to uncached tiles; revisiting the previous area legitimately uses the image cache.
  await picker.getByText(/Map imagery could not load/).waitFor();
  await page.evaluate(()=>{window.mapGeo={latitude:0,longitude:0};});
  await picker.getByRole('button',{name:'Use my current location',exact:true}).click();await picker.getByText('0.00000, 0.00000',{exact:true}).waitFor();
  if(local&&platform==='ios') {
   await page.evaluate(()=>{window.mapDelaySearch=true;});
   await dialog.locator('input[name="locationPhrase"]').fill('Slow search');await dialog.locator('input[name="locationPhrase"]').press('Enter');
   await page.waitForFunction(()=>!!window.mapReleaseSearch);
  }
  await picker.getByRole('button',{name:'Use this location',exact:true}).click();
  if(local&&platform==='ios')await page.evaluate(()=>{window.mapDelaySearch=false;window.mapReleaseSearch();});
  await dialog.getByRole('button',{name:'Save place',exact:true}).click();
  await dialog.getByRole('button').filter({has:page.getByText(placeName,{exact:true})}).waitFor();
  const place=(await resources(page,'savedPlaces')).find(row=>row.name===placeName);assert.ok(place);assert.equal(place.latitude,0);assert.equal(place.longitude,0);assert.equal(place.address,'0.00000, 0.00000');
  await dialog.getByRole('button').filter({has:page.getByText(placeName,{exact:true})}).click();await editor.locator('.reminder-chip').filter({hasText:placeName}).waitFor();
  await page.waitForFunction(name=>window.mapNativeCalls.some(call=>call.method==='syncReminders'&&call.options.reminders.some(row=>row.locationName===name)),placeName);
  assert.deepEqual(errors,[]);assert.ok(Math.max(...zooms)>beforeZoom,'touch pinch zooms the map');
  await page.reload();await editor.locator('.reminder-chip').filter({hasText:placeName}).waitFor();
  console.log(`PASS ${platform} ${local?'device-only':'connected'}: pan/pinch, pin/radius/name, native payload, permissions, cancellation, failed tiles, zero coordinates, saved place and reload`);
  await context.close();
 }
}finally{await browser?.close();await fixture.close();}
