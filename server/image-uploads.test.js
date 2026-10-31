const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');
const { maxFileBytes } = require('../shared/upload-limits.json');

test('photos and attachments accept larger files with a shared 100 MiB cap', async () => {
  const fixture = await startFixture();
  try {
    const credentials = { username: 'photo-owner', password: 'photo-upload-test-password' };
    await fetch(fixture.origin + '/api/setup/admin', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials) });
    const { token } = await (await fetch(fixture.origin + '/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)})).json();
    const headers = {Authorization:`Bearer ${token}`};
    const note = await (await fetch(fixture.origin + '/api/notes', {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({noteTitle:'Photos',labels:[],images:[]})})).json();
    // A file at the boundary exercises the real multipart parser and disk path.
    const bytes = new Uint8Array(maxFileBytes);
    bytes.set([0xff,0xd8,0xff,0xd9]);
    const form = new FormData();form.append('image',new Blob([bytes],{type:'image/jpeg'}),'large-photo.jpg');
    const image = await fetch(fixture.origin + '/api/uploads/images',{method:'POST',headers,body:form});
    assert.equal(image.status,201,await image.clone().text());
    assert.equal((await image.json()).size,maxFileBytes);
    const document = new FormData();document.append('file',new Blob([bytes.subarray(0,26*1024*1024)],{type:'application/pdf'}),'large-document.pdf');
    const attached = await fetch(fixture.origin + `/api/notes/${note.id}/attachments`,{method:'POST',headers,body:document});
    assert.equal(attached.status,201,await attached.clone().text());
    const tooLarge = new FormData();tooLarge.append('file',new Blob([bytes,new Uint8Array(1)],{type:'application/pdf'}),'too-large.pdf');
    const rejected = await fetch(fixture.origin + `/api/notes/${note.id}/attachments`,{method:'POST',headers,body:tooLarge});
    assert.equal(rejected.status,400,await rejected.clone().text());
    assert.match((await rejected.json()).error,/too large/);
    const unsafe = new FormData();unsafe.append('image',new Blob(['<svg onload="alert(1)"/>'],{type:'image/svg+xml'}),'unsafe.svg');
    assert.equal((await fetch(fixture.origin + '/api/uploads/images',{method:'POST',headers,body:unsafe})).status,400,'active image formats remain restricted');
    const job = await (await fetch(fixture.origin + '/api/workspace-import',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({sourceId:'device',generation:'first'})})).json();
    const chunk = size => fetch(fixture.origin + `/api/workspace-import/${job.id}/items`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({key:'photo',kind:'blob',digest:'a'.repeat(64),payload:{blobKey:'media:photo',size,mimeType:'image/jpeg',name:'photo.jpg'},offset:0,base64:''})});
    assert.equal((await chunk(maxFileBytes)).status,200,'local-to-server transfers accept the same file size');
    assert.equal((await chunk(maxFileBytes+1)).status,400);
  } finally { await fixture.close(); }
});
