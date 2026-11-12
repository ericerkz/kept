const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('binder sharing preserves permission sources, identities, organization and offline synchronization', async t => {
  const fixture = await startFixture();let owner, sequence = 0;
  const password = 'binder-sharing-test-password';
  async function api(path,body,token=owner,method=body===undefined?'GET':'POST',status=200) {
    const response = await fetch(fixture.origin+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(response.status,status,await response.clone().text());
    return status===204?null:response.json();
  }
  async function mutate(type,syncId,payload,token=owner,ok=true) {
    const operationId=`binder-test-${++sequence}`;
    const response=await api('/sync/mutations',{protocolVersion:2,mutations:[{type,syncId,payload,operationId,lww:{physicalMs:Date.now()+sequence,logical:sequence,deviceId:'binder-test',operationId}}]},token);
    assert.equal(response.results[0].ok,ok,JSON.stringify(response.results));return response.results[0];
  }
  const createNote=(title,binder,token=owner)=>api('/notes',{noteTitle:title,noteBody:`private content: ${title}`,binder,labels:[],images:[],checkBoxes:[]},token,'POST',201);
  try {
    await api('/setup/admin',{username:'binder-owner',password},undefined,'POST',201);
    owner=(await api('/auth/login',{username:'binder-owner',password})).token;
    const users=[];
    for(const username of ['recipient','other-owner','outsider']) {
      const user=await api('/users',{username,password,displayName:username},owner,'POST',201);
      users.push({...user,token:(await api('/auth/login',{username,password})).token});
    }
    const [recipient,other,outsider]=users;
    const binder=await mutate('binder.upsert','binder-gifts',{name:'Gifts'});
    const first=await createNote('Parents','Gifts');
    const direct=await createNote('Kids','Gifts');
    await api(`/notes/${direct.id}/collaborators`,{userIds:[recipient.id]},owner,'PUT');
    await api(`/notes/${first.id}`,undefined,recipient.token,'GET',404);
    await fixture.sql('ALTER TABLE note_collaborators DROP COLUMN directShare');
    await fixture.restart();
    assert.equal((await api(`/notes/${direct.id}/collaborators`))[0].directShare,true,'upgrading preserves legacy direct shares');
    await api(`/binders/${binder.id}/members`,{userIds:[recipient.id]},owner,'PUT');

    await t.test('edit-binder previews expose only owned memberships and send each public avatar once',async()=>{
      await api('/users/me/profile',{avatarPreset:'panda'},recipient.token,'PATCH');
      const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
      await api('/users/me/profile',{avatarDataUrl:photo},other.token,'PATCH');
      const extra=await mutate('binder.upsert','preview-extra',{name:'Preview extras'});
      await api(`/binders/${extra.id}/members`,{userIds:[recipient.id,other.id]},owner,'PUT');
      const previews=await api('/binders?includeSharing=1');
      assert.equal(previews.memberships.filter(item=>item.userId===recipient.id).length,2);
      assert.equal(previews.users.filter(user=>user.id===recipient.id).length,1,'profiles are not repeated for every binder');
      assert.equal(previews.users.find(user=>user.id===recipient.id).avatarPreset,'panda');
      assert.equal(previews.users.find(user=>user.id===other.id).avatarDataUrl,photo);
      for(const user of previews.users) {
        assert.equal(Object.hasOwn(user,'passwordHash'),false);
        assert.equal(Object.hasOwn(user,'email'),false);
      }
      const received=await api('/binders?includeSharing=1',undefined,recipient.token);
      assert.deepEqual(received.memberships,[],'received binder membership is not included in owner-edit previews');
      assert.deepEqual(received.users,[]);
      const unrelated=await api('/binders?includeSharing=1',undefined,outsider.token);
      assert.deepEqual(unrelated.memberships,[]);assert.deepEqual(unrelated.users,[]);
      assert.equal(Object.hasOwn(await api('/binders'),'users'),false,'ordinary catalog responses stay unchanged');
    });

    await t.test('existing and future owner notes share automatically, including offline writes',async()=>{
      assert.equal((await api(`/notes/${first.id}`,undefined,recipient.token)).sharedBinder.id,binder.id);
      const future=await createNote('Future','Gifts');
      assert.equal((await api(`/notes/${future.id}`,undefined,recipient.token)).sharedBinder.id,binder.id);
      const synced=await mutate('note.upsert','note-offline-binder',{noteTitle:'Created offline',noteBody:'Offline body',binder:'Gifts',labels:[],images:[],checkBoxes:[]});
      assert.equal((await api(`/notes/${synced.id}`,undefined,recipient.token)).sharedBinder.id,binder.id);
      const boot=await api('/sync/bootstrap?protocolVersion=2',undefined,recipient.token);
      assert.ok(boot.binders.some(item=>item.id===binder.id&&item.shared&&item.ownerUserId!==recipient.id));
      assert.ok(boot.notes.some(item=>item.id===future.id&&item.sharedBinder.id===binder.id));
      const cards=await api('/notes?view=card',undefined,recipient.token);
      assert.equal(cards.notes.find(note=>note.id===first.id).sharedBinder.id,binder.id);
    });

    let imageUrl,attachment;
    await t.test('binder access covers images and attachments, while reminders stay per-user',async()=>{
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
      const image=new FormData();image.append('image',new Blob([png],{type:'image/png'}),'pixel.png');
      const uploaded=await fetch(fixture.origin+'/api/uploads/images',{method:'POST',headers:{Authorization:`Bearer ${owner}`},body:image});
      assert.equal(uploaded.status,201);imageUrl=(await uploaded.json()).url;
      await api(`/notes/${first.id}`,{images:[{id:'photo',dataUrl:imageUrl,placement:'top'}]},owner,'PATCH',204);
      const form=new FormData();form.append('file',new Blob(['gift list'],{type:'text/plain'}),'gifts.txt');
      const file=await fetch(fixture.origin+`/api/notes/${first.id}/attachments`,{method:'POST',headers:{Authorization:`Bearer ${owner}`},body:form});
      assert.equal(file.status,201);attachment=await file.json();
      for (const path of [imageUrl,`/api/attachments/${attachment.id}`]) {
        assert.equal((await fetch(new URL(path,fixture.origin),{headers:{Authorization:`Bearer ${recipient.token}`}})).status,200);
        assert.equal((await fetch(new URL(path,fixture.origin),{headers:{Authorization:`Bearer ${outsider.token}`}})).status,404);
      }
      const dueAtUtc=new Date(Date.now()+86400000).toISOString();
      await mutate('reminder.upsert','binder-recipient-reminder',{noteSyncId:first.syncId,dueAtUtc,timezone:'UTC'},recipient.token);
      await mutate('reminder.upsert','binder-owner-reminder',{noteSyncId:first.syncId,dueAtUtc,timezone:'UTC'});
      const boot=await api('/sync/bootstrap?protocolVersion=2',undefined,recipient.token);
      assert.ok(boot.reminders.some(reminder=>reminder.syncId==='binder-recipient-reminder'));
      assert.equal(boot.reminders.some(reminder=>reminder.syncId==='binder-owner-reminder'),false);
    });

    await t.test('moving out revokes binder-only access but preserves a direct share',async()=>{
      await api(`/notes/${first.id}`,{binder:''},owner,'PATCH',204);
      await api(`/notes/${first.id}`,undefined,recipient.token,'GET',404);
      await api(`/notes/${first.id}/collaborators/rejoin`,{},recipient.token,'POST',403);
      const changes=await api('/sync/changes?protocolVersion=2',undefined,recipient.token);
      assert.ok(changes.changes.some(change=>change.resourceSyncId===first.syncId&&change.operation==='delete'));
      assert.equal(JSON.stringify(changes).includes('private content: Parents'),false);
      assert.ok(changes.changes.some(change=>change.resourceSyncId===attachment.syncId&&change.operation==='delete'));
      assert.ok(changes.changes.some(change=>change.resourceSyncId==='binder-recipient-reminder'&&change.operation==='delete'));
      assert.ok((await api('/sync/bootstrap?protocolVersion=2')).reminders.some(reminder=>reminder.syncId==='binder-owner-reminder'));
      for (const path of [imageUrl,`/api/attachments/${attachment.id}`]) assert.equal((await fetch(new URL(path,fixture.origin),{headers:{Authorization:`Bearer ${recipient.token}`}})).status,404);
      await api(`/notes/${direct.id}`,{binder:''},owner,'PATCH',204);
      assert.equal((await api(`/notes/${direct.id}`,undefined,recipient.token)).sharedBinder,undefined);
      await api(`/notes/${first.id}`,{binder:'Gifts'},owner,'PATCH',204);
      assert.equal((await api(`/notes/${first.id}`,undefined,recipient.token)).sharedBinder.id,binder.id);
      const recovered=await api('/sync/changes?protocolVersion=2',undefined,recipient.token);
      assert.ok(recovered.changes.some(change=>change.resourceSyncId===attachment.syncId&&change.operation==='upsert'));
      assert.ok(recovered.changes.some(change=>change.resourceSyncId==='binder-recipient-reminder'&&change.operation==='upsert'));
    });

    await t.test('direct access can be added or removed without changing inherited access',async()=>{
      await api(`/notes/${first.id}/collaborators`,{userIds:[recipient.id],directUserIds:[recipient.id]},owner,'PUT');
      assert.equal((await api(`/notes/${first.id}/collaborators`))[0].directShare,true);
      await api(`/notes/${first.id}/collaborators`,{userIds:[]},owner,'PUT');
      const collaborator=(await api(`/notes/${first.id}/collaborators`))[0];
      assert.equal(collaborator.directShare,false);assert.equal(collaborator.sharedViaBinder,'Gifts');
      await api(`/notes/${first.id}/collaborators`,{userIds:[recipient.id]},owner,'PUT');
      assert.equal((await api(`/notes/${first.id}/collaborators`))[0].directShare,false,'an old client must not promote inherited access');
      assert.equal((await api(`/notes/${first.id}`,undefined,recipient.token)).sharedBinder.id,binder.id);
    });

    await t.test('recipient organization stays personal and cannot reshare a third-party note',async()=>{
      await api('/users/me/preferences',{inheritSharedBinders:false,inheritSharedLabels:false},recipient.token,'PATCH');
      await api(`/notes/${first.id}/organization`,{binder:'My plans',labels:[{name:'Private label',added:true}]},recipient.token,'PATCH');
      const personal=await api(`/notes/${first.id}`,undefined,recipient.token);
      assert.equal(personal.binder,'My plans');assert.equal(personal.sharedBinder.id,binder.id);
      assert.equal((await api(`/notes/${first.id}`)).binder,'Gifts');
      const personalBinder=await mutate('binder.upsert','binder-personal',{name:'My plans'},recipient.token);
      await api(`/binders/${personalBinder.id}/members`,{userIds:[outsider.id]},recipient.token,'PUT');
      await api(`/notes/${first.id}`,undefined,outsider.token,'GET',404);
      await api(`/notes/${first.id}/collaborators`,{userIds:[outsider.id]},recipient.token,'PUT',404);
      await api(`/notes/${first.id}`,{noteBody:'Recipient edit',binder:'Not the owner binder'},recipient.token,'PATCH',204);
      assert.equal((await api(`/notes/${first.id}`)).binder,'Gifts');
      assert.equal((await api(`/notes/${first.id}`)).noteBody,'Recipient edit');
    });

    await t.test('same-name binders from different owners remain distinct and renaming preserves membership',async()=>{
      const otherBinder=await mutate('binder.upsert','binder-other-gifts',{name:'Gifts'},other.token);
      const otherNote=await createNote('Other gifts','Gifts',other.token);
      await api(`/binders/${otherBinder.id}/members`,{userIds:[recipient.id]},other.token,'PUT');
      let resources=await api('/sync/bootstrap?protocolVersion=2',undefined,recipient.token);
      assert.equal(resources.binders.filter(item=>item.shared&&item.name==='Gifts').length,2);
      assert.equal((await api(`/notes/${otherNote.id}`,undefined,recipient.token)).sharedBinder.id,otherBinder.id);
      await mutate('binder.upsert','binder-gifts',{name:'Family gifts'});
      assert.equal((await api(`/notes/${first.id}`,undefined,recipient.token)).sharedBinder.name,'Family gifts');
      assert.equal((await api(`/notes/${first.id}`,undefined,recipient.token)).binder,'My plans');
      resources=await api('/sync/bootstrap?protocolVersion=2',undefined,recipient.token);
      assert.equal(resources.binders.find(item=>item.shared&&item.id===binder.id).name,'Family gifts');
      assert.equal(resources.binders.find(item=>item.shared&&item.id===otherBinder.id).name,'Gifts');
    });

    await t.test('only binder owners manage sharing; fabricated identities and invalid requests grant nothing',async()=>{
      await api(`/binders/${binder.id}/members`,{userIds:[outsider.id]},recipient.token,'PUT',404);
      await api(`/binders/${binder.id}/members`,undefined,outsider.token,'GET',404);
      await api(`/binders/${binder.id}/members`,{userIds:['bad']},owner,'PUT',400);
      await mutate('binder.upsert',`shared-binder-${binder.id}`,{name:'Stolen binder',id:binder.id},recipient.token,false);
      await mutate('binder.delete',`shared-binder-${binder.id}`,{},recipient.token,false);
      await api(`/notes/${first.id}`,undefined,outsider.token,'GET',404);
      await api(`/notes/${first.id}`,undefined,recipient.token,'DELETE',409);
      await fixture.sql(`CREATE TRIGGER test_binder_rollback BEFORE INSERT ON binder_note_grants
        WHEN NEW.userId = ${outsider.id} BEGIN SELECT RAISE(ABORT,'Test binder rollback'); END`);
      try { await api(`/binders/${binder.id}/members`,{userIds:[outsider.id]},owner,'PUT',409); }
      finally { await fixture.sql('DROP TRIGGER test_binder_rollback'); }
      assert.equal((await api(`/binders/${binder.id}/members`)).members[0].id,recipient.id,'failed sharing changes roll back membership');
      await api(`/notes/${first.id}`,undefined,outsider.token,'GET',404);
    });

    await t.test('members contribute, remove, trash and restore notes without granting management or permanent deletion',async()=>{
      const together=await mutate('binder.upsert','binder-together',{name:'Together'});
      await api(`/binders/${together.id}/members`,{userIds:[recipient.id,other.id]},owner,'PUT');
      const contributed=await api('/notes',{noteTitle:'Member contribution',noteBody:'Created by a member',binderTargetId:together.id,labels:[],images:[],checkBoxes:[]},recipient.token,'POST',201);
      assert.equal(contributed.ownerUserId,recipient.id);
      for(const token of [owner,recipient.token,other.token]) assert.equal((await api(`/notes/${contributed.id}`,undefined,token)).noteBody,'Created by a member');
      await api(`/notes/${contributed.id}`,undefined,outsider.token,'GET',404);
      await api(`/notes/${contributed.id}/collaborators`,{userIds:[outsider.id]},recipient.token,'PUT');
      assert.equal((await api(`/notes/${contributed.id}`,undefined,outsider.token)).sharedBinder,undefined,'a direct share does not disclose binder membership or confer member permissions');
      await api(`/notes/${contributed.id}`,{trashed:true},outsider.token,'PATCH',204);
      assert.equal((await api(`/notes/${contributed.id}`,undefined,recipient.token)).trashed,false);
      await api(`/notes/${contributed.id}/binder`,{binderId:null},outsider.token,'PATCH',404);
      const offline=await mutate('note.upsert','member-offline-note',{noteTitle:'Offline contribution',binderTargetId:together.id,labels:[],images:[],checkBoxes:[]},recipient.token);
      assert.equal((await api(`/notes/${offline.id}`,undefined,owner)).sharedBinder.id,together.id);
      await api(`/notes/${contributed.id}`,{trashed:true},other.token,'PATCH',204);
      assert.equal((await api(`/notes/${contributed.id}`,undefined,recipient.token)).trashed,true);
      const snapshot=await api(`/notes/${contributed.id}`,undefined,other.token);
      await mutate('note.upsert',contributed.syncId,{...snapshot,trashed:false},other.token);
      assert.equal((await api(`/notes/${contributed.id}`,undefined,owner)).trashed,false);
      await api(`/notes/${contributed.id}`,undefined,other.token,'DELETE',409);
      await mutate('note.delete',contributed.syncId,{},other.token,false);
      const privateNote=await createNote('Not mine','',outsider.token);
      await api(`/notes/${privateNote.id}/collaborators`,{userIds:[recipient.id]},outsider.token,'PUT');
      await api(`/notes/${privateNote.id}/binder`,{binderId:together.id},recipient.token,'PATCH',404);
      await api(`/notes/${privateNote.id}`,{trashed:true},recipient.token,'PATCH',204);
      assert.equal((await api(`/notes/${privateNote.id}`,undefined,outsider.token)).trashed,false,'ordinary note sharing does not gain Trash permissions');
      await api(`/notes/${contributed.id}/binder`,{binderId:999999},recipient.token,'PATCH',404);
      await mutate('binder.upsert','binder-together',{name:'Together renamed'});
      assert.equal((await api(`/notes/${contributed.id}`,undefined,other.token)).sharedBinder.name,'Together renamed');
      await mutate('note.binder',contributed.syncId,{binderId:null},other.token);
      await api(`/notes/${contributed.id}`,undefined,owner,'GET',404);
      await api(`/notes/${contributed.id}`,undefined,other.token,'GET',404);
      assert.equal((await api(`/notes/${contributed.id}`,undefined,recipient.token)).binder,'');
      await api(`/notes/${contributed.id}`,{binder:'Together renamed'},recipient.token,'PATCH',204);
      await api(`/notes/${contributed.id}`,undefined,owner,'GET',404); // Ordinary autosave must not resurrect removed membership.
      await mutate('note.binder',contributed.syncId,{binderId:together.id},recipient.token);
      await fixture.restart();
      assert.equal((await api(`/notes/${contributed.id}`,undefined,owner)).ownerUserId,recipient.id);
      await api(`/binders/${together.id}/members`,{userIds:[other.id]},owner,'PUT');
      await mutate('note.binder',contributed.syncId,{binderId:together.id},recipient.token,false);
      await mutate('binder.delete','binder-together',{});
      assert.equal((await api(`/notes/${contributed.id}`,undefined,recipient.token)).binder,'');
      await api(`/notes/${contributed.id}`,undefined,owner,'GET',404);
      await api(`/notes/${contributed.id}`,undefined,other.token,'GET',404);
    });

    await t.test('membership survives restart and owner revocation removes cached access without affecting direct shares',async()=>{
      await fixture.restart();
      assert.equal((await api(`/notes/${first.id}`,undefined,recipient.token)).sharedBinder.id,binder.id);
      await api(`/binders/${binder.id}/members`,{userIds:[]},owner,'PUT');
      await api(`/notes/${first.id}`,undefined,recipient.token,'GET',404);
      await api(`/notes/${first.id}/collaborators/rejoin`,{},recipient.token,'POST',403);
      assert.equal((await api(`/notes/${direct.id}`,undefined,recipient.token)).id,direct.id);
      const boot=await api('/sync/bootstrap?protocolVersion=2',undefined,recipient.token);
      assert.equal(boot.binders.some(item=>item.shared&&item.id===binder.id),false);
      const changes=await api('/sync/changes?protocolVersion=2',undefined,recipient.token);
      assert.ok(changes.changes.some(change=>change.resourceType==='binder'&&change.resourceSyncId===`shared-binder-${binder.id}`&&change.operation==='delete'));
      assert.equal(changes.changes.some(change=>change.resourceSyncId===first.syncId&&change.operation==='upsert'),false);
      const future=await createNote('After revocation','Family gifts');
      await api(`/notes/${future.id}`,undefined,recipient.token,'GET',404);
    });

    await t.test('leaving and deleting binders remove only binder access',async()=>{
      await api(`/binders/${binder.id}/members`,{userIds:[recipient.id]},owner,'PUT');
      await api(`/binders/${binder.id}/membership`,undefined,recipient.token,'DELETE',204);
      await api(`/notes/${first.id}`,undefined,recipient.token,'GET',404);
      assert.equal((await api(`/notes/${direct.id}`,undefined,recipient.token)).id,direct.id);
      await api(`/binders/${binder.id}/members`,{userIds:[recipient.id]},owner,'PUT');
      await mutate('binder.delete','binder-gifts',{});
      await api(`/notes/${first.id}`,undefined,recipient.token,'GET',404);
      assert.equal((await api(`/notes/${direct.id}`,undefined,recipient.token)).id,direct.id);
      assert.equal((await api(`/notes/${first.id}`)).binder,'');
      assert.equal((await api('/sync/bootstrap?protocolVersion=2',undefined,recipient.token)).binders.some(item=>item.shared&&item.id===binder.id),false);
    });
  } finally { await fixture.close(); }
});
