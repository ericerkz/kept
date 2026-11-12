const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('shared organization defaults to the owner, with independent account preferences and private choices', async () => {
  const fixture = await startFixture();
  let ownerToken, sequence = 0;
  const password = 'organization-test-password';
  async function api(path, body, token = ownerToken, method = body === undefined ? 'GET' : 'POST', status = 200) {
    const response = await fetch(fixture.origin + '/api' + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, status, await response.clone().text());
    return status === 204 ? null : response.json();
  }
  async function mutate(type, syncId, payload, token, physicalMs = Date.now()) {
    const operationId = `organization-${++sequence}`;
    const response = await api('/sync/mutations', { protocolVersion: 2, mutations: [{ type, syncId, payload,
      operationId, lww: { physicalMs, logical: sequence, deviceId: 'test', operationId } }] }, token);
    assert.equal(response.results[0].ok, true, JSON.stringify(response.results));
    return response.results[0];
  }
  try {
    await api('/setup/admin', { username: 'owner', password }, undefined, 'POST', 201);
    ownerToken = (await api('/auth/login', { username: 'owner', password })).token;
    const users = [];
    for (const username of ['recipient', 'family', 'outsider']) {
      const user = await api('/users', { username, displayName: username, password }, ownerToken, 'POST', 201);
      users.push({ ...user, token: (await api('/auth/login', { username, password })).token });
    }
    const [recipient, family, outsider] = users;
    const note = await api('/notes', { noteTitle: 'Trip list', noteBody: 'Keep shared content', binder: 'Family trip',
      labels: [{ name: 'Travel', added: true }], images: [], checkBoxes: [] }, ownerToken, 'POST', 201);
    await api(`/notes/${note.id}/collaborators`, { userIds: [recipient.id, family.id] }, ownerToken, 'PUT');
    const upgradeCursor = (await api('/sync/changes?protocolVersion=2', undefined, recipient.token)).cursor;
    await fixture.sql('DROP TABLE user_note_organization');
    await fixture.restart();
    const upgradeChanges = await api(`/sync/changes?protocolVersion=2&cursor=${upgradeCursor}`, undefined, recipient.token);
    assert.ok(upgradeChanges.changes.some(change => change.resourceSyncId === note.syncId && change.payload.sharedOrganization),
      'upgrading publishes metadata for already-cached shared notes');
    const getNote = token => api(`/notes/${note.id}`, undefined, token);
    const prefs = (patch, token = recipient.token) => api('/users/me/preferences', patch, token, 'PATCH');
    const defaults = await api('/users/me/preferences', undefined, recipient.token);
    assert.equal(defaults.inheritSharedLabels, true);
    assert.equal(defaults.inheritSharedBinders, true);
    assert.equal((await getNote(recipient.token)).binder, 'Family trip');
    assert.equal((await getNote(recipient.token)).labels[0].name, 'Travel');
    await prefs({ inheritSharedBinders: false });
    assert.equal((await getNote(recipient.token)).binder, '');
    assert.equal((await getNote(recipient.token)).labels[0].name, 'Travel', 'the two settings are independent');
    const ownerBefore = await getNote(ownerToken);
    await api(`/notes/${note.id}/organization`, { binder: 'My plans', userId: family.id }, recipient.token, 'PATCH');
    assert.equal((await getNote(recipient.token)).binder, 'My plans');
    assert.equal((await getNote(family.token)).binder, 'Family trip');
    await prefs({ inheritSharedLabels: false });
    assert.deepEqual((await getNote(recipient.token)).labels, []);
    const privateWrite = await mutate('note.organization', note.syncId, { labels: [{ name: 'Personal', added: true }] }, recipient.token, Date.now() + 50);
    assert.equal(privateWrite.canonical.labels[0].name, 'Personal');
    assert.equal(privateWrite.canonical.binder, 'My plans');
    const ownerChanges = await api('/sync/changes?protocolVersion=2', undefined, ownerToken);
    const familyChanges = await api('/sync/changes?protocolVersion=2', undefined, family.token);
    for (const changes of [ownerChanges, familyChanges]) {
      assert.equal(JSON.stringify(changes).includes('My plans'), false, 'private choices are not published to anyone else');
      assert.equal(JSON.stringify(changes).includes('Personal'), false);
    }
    assert.equal((await getNote(ownerToken)).binder, ownerBefore.binder);
    assert.equal((await getNote(ownerToken)).updatedAt, ownerBefore.updatedAt, 'personal organization does not edit the shared note');
    assert.deepEqual((await getNote(ownerToken)).labels, ownerBefore.labels);
    const recipientView = await getNote(recipient.token);
    for (const path of ['/notes', '/notes?view=card', '/sync/bootstrap?protocolVersion=2']) {
      const result = await api(path, undefined, recipient.token);
      const visible = (Array.isArray(result) ? result : result.notes).find(item => item.id === note.id);
      assert.equal(visible.binder, 'My plans', path);
      assert.equal(visible.labels[0].name, 'Personal', path);
      assert.deepEqual(visible.sharedOrganization, recipientView.sharedOrganization);
    }
    assert.equal((await api('/notes?view=card&q=Personal', undefined, recipient.token)).notes.length, 1);
    assert.equal((await api('/notes?view=card&q=Travel', undefined, recipient.token)).notes.length, 0);
    assert.equal((await api('/notes?view=card&q=!label:personal', undefined, recipient.token)).notes.length, 1);
    assert.equal((await api('/notes/search?q=Personal', undefined, recipient.token))[0].binder, 'My plans');
    await prefs({ inheritSharedLabels: true, inheritSharedBinders: true });
    assert.equal((await getNote(recipient.token)).binder, 'Family trip');
    assert.equal((await getNote(recipient.token)).labels[0].name, 'Travel');
    const syncedPreference = await mutate('preferences.patch', 'account-preferences', { inheritSharedLabels: false }, family.token);
    assert.equal(syncedPreference.canonical.inheritSharedLabels, false);
    assert.equal(syncedPreference.canonical.inheritSharedBinders, true);
    assert.deepEqual((await getNote(family.token)).labels, []);
    await mutate('preferences.patch', 'account-preferences', { inheritSharedLabels: true }, family.token);
    await api(`/notes/${note.id}`, { binder: 'New owner binder', labels: [{ name: 'Owner change', added: true }] }, ownerToken, 'PATCH', 204);
    assert.equal((await getNote(family.token)).binder, 'New owner binder');
    await prefs({ inheritSharedLabels: false, inheritSharedBinders: false });
    assert.equal((await getNote(recipient.token)).binder, 'My plans', 'personal choices survive re-enabling inheritance');
    assert.equal((await getNote(recipient.token)).labels[0].name, 'Personal');
    // Old content autosaves cannot replace either the owner's or recipient's organization.
    await api(`/notes/${note.id}`, { ...recipientView, noteBody: 'Updated shared content', binder: 'Stale', labels: [] }, recipient.token, 'PUT', 204);
    assert.equal((await getNote(recipient.token)).binder, 'My plans');
    assert.equal((await getNote(ownerToken)).binder, 'New owner binder');
    assert.equal((await getNote(ownerToken)).noteBody, 'Updated shared content');
    // A stale personal operation cannot undo a later personal move.
    await mutate('note.organization', note.syncId, { binder: 'Latest' }, recipient.token, Date.now() + 500);
    await mutate('note.organization', note.syncId, { binder: 'Old device' }, recipient.token, Date.now() - 5000);
    assert.equal((await getNote(recipient.token)).binder, 'Latest');
    // Renames/deletes of a personal catalog affect only that user's assignment.
    let boot = await api('/sync/bootstrap?protocolVersion=2', undefined, recipient.token);
    const binder = boot.binders.find(item => item.name === 'Latest');
    await mutate('binder.upsert', binder.syncId, { name: 'Renamed' }, recipient.token, Date.now() + 1000);
    assert.equal((await getNote(recipient.token)).binder, 'Renamed');
    await mutate('binder.delete', binder.syncId, {}, recipient.token, Date.now() + 2000);
    assert.equal((await getNote(recipient.token)).binder, '');
    boot = await api('/sync/bootstrap?protocolVersion=2', undefined, recipient.token);
    const label = boot.labels.find(item => item.name === 'Personal');
    await mutate('label.upsert', label.syncId, { name: 'Private label' }, recipient.token, Date.now() + 1000);
    assert.equal((await getNote(recipient.token)).labels[0].name, 'Private label');
    assert.equal((await getNote(family.token)).labels[0].name, 'Owner change');
    await api(`/notes/${note.id}/organization`, { binder: 'Not yours' }, outsider.token, 'PATCH', 404);
    await api('/users/me/preferences', { inheritSharedLabels: 'false' }, recipient.token, 'PATCH', 400);
    await api(`/notes/${note.id}/collaborators`, { userIds: [family.id] }, ownerToken, 'PUT');
    await api(`/notes/${note.id}/organization`, { binder: 'Revoked' }, recipient.token, 'PATCH', 404);
  } finally { await fixture.close(); }
});

test('label counts include all accessible non-trashed notes and respect private label preferences',async()=>{
  const fixture=await startFixture();let owner;
  const password='label-counts-test-password';
  async function api(path,body,token=owner,method=body===undefined?'GET':'POST',status=200) {
    const response=await fetch(fixture.origin+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(response.status,status,await response.clone().text());return status===204?null:response.json();
  }
  const label=name=>({name,added:true});
  const create=(payload,token=owner)=>api('/notes',{noteTitle:'Counted note',noteBody:'',images:[],checkBoxes:[],...payload},token,'POST',201);
  try {
    await api('/setup/admin',{username:'count-owner',password},undefined,'POST',201);
    owner=(await api('/auth/login',{username:'count-owner',password})).token;
    const recipient=await api('/users',{username:'count-recipient',password},owner,'POST',201);
    const recipientToken=(await api('/auth/login',{username:'count-recipient',password})).token;
    const shared=await create({labels:[label('Beer'),label('Beer'),{name:'Unchecked',added:false}]});
    await create({labels:[label('Beer')],archived:true});
    await create({labels:[label('Beer')],trashed:true});
    await create({labels:[label('Private elsewhere')]},recipientToken);
    assert.deepEqual(await api('/labels/counts'),{Beer:2},'archive counts, trash and unchecked labels do not');
    await api(`/notes/${shared.id}/collaborators`,{userIds:[recipient.id]},owner,'PUT');
    assert.deepEqual(await api('/labels/counts',undefined,recipientToken),{Beer:1,'Private elsewhere':1});
    await api('/users/me/preferences',{inheritSharedLabels:false},recipientToken,'PATCH');
    await api(`/notes/${shared.id}/organization`,{labels:[label('My label')]},recipientToken,'PATCH');
    assert.deepEqual(await api('/labels/counts',undefined,recipientToken),{'My label':1,'Private elsewhere':1});
    assert.deepEqual(await api('/labels/counts'),{Beer:2},'private organization never changes another user\'s counts');
    await api(`/notes/${shared.id}`,{trashed:true},owner,'PATCH',204);
    assert.deepEqual(await api('/labels/counts',undefined,recipientToken),{'Private elsewhere':1});
    await api(`/notes/${shared.id}`,{trashed:false},owner,'PATCH',204);
    await api(`/notes/${shared.id}/collaborators`,{userIds:[]},owner,'PUT');
    assert.deepEqual(await api('/labels/counts',undefined,recipientToken),{'Private elsewhere':1},'revoked notes are not counted');
  } finally {await fixture.close();}
});
