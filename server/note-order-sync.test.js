const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');
const { createStore } = require('../test-support/workspace-store.cjs');

test('large grid moves sync positions across devices without rewriting contents; old clients still receive full notes', async t => {
  const fixture = await startFixture(); t.after(() => fixture.close());
  let token, counter = 0;
  async function api(route, body, method = body ? 'POST' : 'GET', access = token) {
    const response = await fetch(fixture.origin + '/api' + route, { method,
      headers: { ...(access ? { Authorization: `Bearer ${access}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, await response.clone().text());
    return response.status === 204 ? null : response.json();
  }
  const credentials = { username: 'order-owner', password: 'isolated-order-test-password' };
  await api('/setup/admin', credentials); token = (await api('/auth/login', credentials)).token;
  const [owner] = await fixture.sql("SELECT id FROM users WHERE username = 'order-owner'");
  const source = Array.from({ length: 500 }, (_, i) => ({ syncId: `order-${i}`, title: `Imported ${i}`, body: `<p>${'Unchanged imported text. '.repeat(100)}</p>`, pinned: i < 5 }));
  const date = new Date().toISOString();
  await fixture.sql(`INSERT INTO notes(ownerUserId,syncId,noteTitle,noteBody,pinned,sortOrder,createdAt,updatedAt)
    SELECT ?,json_extract(value,'$.syncId'),json_extract(value,'$.title'),json_extract(value,'$.body'),json_extract(value,'$.pinned'),500 - CAST(key AS INTEGER),?,? FROM json_each(?)`, [owner.id,date,date,JSON.stringify(source)]);
  await fixture.sql('INSERT INTO user_pins(userId,noteId) SELECT ?,id FROM notes WHERE ownerUserId = ? AND pinned = 1',[owner.id,owner.id]);
  const pins=await fixture.sql('SELECT * FROM user_pins ORDER BY noteId');
  const before = await fixture.sql('SELECT * FROM notes ORDER BY id');
  const boot = await api('/sync/bootstrap?protocolVersion=2');
  const first = createStore(), second = createStore();
  const w1 = await first.ensureServerWorkspace('order-device-one'), w2 = await second.ensureServerWorkspace('order-device-two');
  t.after(async () => { (await first.open()).close(); (await second.open()).close(); });
  for (const [store,w] of [[first,w1],[second,w2]]) await store.reconcile(w,{snapshot:{note:boot.notes},cursor:boot.cursor});
  const ids = source.map(row => row.syncId); ids.splice(10,0,ids.splice(400,1)[0]);
  await first.commitMutation(w1,'note.reorder','note-order',{syncIds:ids,movedSyncId:'order-400'});
  const [operation] = await first.listOutbox(w1.partition);
  const started = performance.now();
  const send = async operations => api('/sync/mutations',{protocolVersion:2,responseMode:'ack',mutations:operations});
  const ack = await send([operation]);
  const elapsed = performance.now() - started;
  assert.equal(ack.results[0].ok,true); assert.equal(ack.snapshot,undefined);
  await first.reconcile(w1,{sent:[operation],results:ack.results});
  assert.equal((await first.listOutbox(w1.partition)).length,0);
  const compact = await api(`/sync/changes?protocolVersion=2&notePositions=1&cursor=${boot.cursor}&limit=1000`);
  assert.equal(compact.changes.length,1,'a single drag publishes one changed position, not the entire library');
  assert.equal(ack.results[0].positions.length,1);
  assert.ok(compact.changes.every(change => change.resourceType === 'notePosition' && Object.keys(change.payload).sort().join() === 'id,sortOrder,syncId'));
  for (const [store,w] of [[first,w1],[second,w2]]) await store.reconcile(w,{changes:compact.changes,cursor:compact.cursor});
  const revision = (await first.getWorkspace(w1.id)).revision;
  assert.equal(await first.reconcile(w1,{changes:compact.changes,cursor:compact.cursor}),false);
  assert.equal((await first.getWorkspace(w1.id)).revision,revision,'an acknowledged position echo does not rebuild the cache or widgets');
  const order = async (store,w) => Array.from(await store.listNotes(w.partition)).filter(note=>note.syncId.startsWith('order-')).sort((a,b)=>b.sortOrder-a.sortOrder).map(note=>note.syncId);
  assert.deepEqual(await order(first,w1),ids); assert.deepEqual(await order(second,w2),ids);
  assert.deepEqual(await fixture.sql('SELECT * FROM notes ORDER BY id'),before,'positions never edit content, pins, timestamps or content LWW stamps');
  assert.deepEqual(await fixture.sql('SELECT * FROM user_pins ORDER BY noteId'),pins);
  assert.equal((await api('/sync/bootstrap?protocolVersion=2')).notes.filter(note=>note.pinned).length,5);
  const oldV2 = await api(`/sync/changes?protocolVersion=2&cursor=${boot.cursor}&limit=1000`);
  const oldV1 = await api(`/sync/changes?cursor=${boot.cursor}&limit=1000`);
  for (const response of [oldV1,oldV2]) {
    assert.equal(response.changes.length,1);
    assert.ok(response.changes.every(change=>change.resourceType==='note' && change.payload.noteBody));
  }
  assert.ok(JSON.stringify(compact).length < JSON.stringify(oldV2).length / 5);
  // An overlapping move from another device converges by server application
  // order, as before. Retrying the first operation cannot undo the newer move.
  const next = [...ids].reverse();
  const mutation = {type:'note.reorder',syncId:'note-order',payload:{syncIds:next},operationId:`second-${++counter}`,lww:{physicalMs:Date.now(),logical:counter,deviceId:'second',operationId:'second'}};
  const legacyAck = await send([mutation]);
  assert.equal(legacyAck.results[0].positions.length,500,'pre-upgrade queued full reorders receive every canonical position');
  await send([operation]);
  let cursor=compact.cursor, hasMore=true, pages=[];
  while(hasMore) { const page=await api(`/sync/changes?protocolVersion=2&notePositions=1&cursor=${cursor}&limit=37`); pages.push(...page.changes); cursor=page.cursor; hasMore=page.hasMore; }
  for (const [store,w] of [[first,w1],[second,w2]]) { await store.reconcile(w,{changes:pages,cursor}); assert.deepEqual(await order(store,w),next); }
  const replay=await send([operation]);
  await first.reconcile(w1,{sent:[operation],results:replay.results});
  assert.deepEqual(await order(first,w1),next,'a replay acknowledgement cannot undo a move already received on the feed');
  // Direct reorder endpoint (older/browser clients) feeds the same stream.
  const subset=boot.notes.slice(0,3).map(note=>note.id).reverse();
  await api('/notes/reorder',{ids:subset},'PATCH');
  const direct=await api(`/sync/changes?protocolVersion=2&notePositions=1&cursor=${cursor}`);
  assert.equal(direct.changes.length,3); assert.ok(direct.changes.every(change=>change.resourceType==='notePosition'));
  // Positions are private to the current user and cannot grant note access.
  await api('/users',{username:'unrelated',password:credentials.password,role:'user'});
  const other=(await api('/auth/login',{username:'unrelated',password:credentials.password})).token;
  const denied=await api('/sync/mutations',{protocolVersion:2,responseMode:'ack',mutations:[{...mutation,operationId:'denied-order'}]},'POST',other);
  assert.deepEqual(denied.results[0].positions,[]);
  assert.equal((await api('/sync/changes?protocolVersion=2&notePositions=1&cursor=0',undefined,'GET',other)).changes.filter(change=>['note','notePosition'].includes(change.resourceType)).length,0);
  const [otherUser]=await fixture.sql("SELECT id FROM users WHERE username = 'unrelated'");
  const sharedId=subset[0],ownerPosition=(await api(`/notes/${sharedId}`)).sortOrder;
  await api(`/notes/${sharedId}/collaborators`,{userIds:[otherUser.id]},'PUT');
  const otherBoot=await api('/sync/bootstrap?protocolVersion=2',undefined,'GET',other);
  await api('/notes/reorder',{ids:[sharedId]},'PATCH',other);
  assert.equal((await api(`/notes/${sharedId}`)).sortOrder,ownerPosition,'a collaborator move never changes the owner grid');
  const otherMove=await api(`/sync/changes?protocolVersion=2&notePositions=1&cursor=${otherBoot.cursor}`,undefined,'GET',other);
  assert.equal(otherMove.changes.filter(change=>change.resourceType==='notePosition').length,1);
  await api(`/notes/${sharedId}/collaborators`,{userIds:[]},'PUT');
  const revoked=await api(`/sync/changes?protocolVersion=2&notePositions=1&cursor=${otherBoot.cursor}`,undefined,'GET',other);
  assert.ok(revoked.changes.filter(change=>change.resourceType==='notePosition').every(change=>change.operation==='delete' && change.payload===null));
  await fixture.restart();
  assert.equal((await api('/sync/bootstrap?protocolVersion=2')).notes.find(note=>note.id===subset[0]).sortOrder > (await api('/sync/bootstrap?protocolVersion=2')).notes.find(note=>note.id===subset[1]).sortOrder,true);
  t.diagnostic(`500-note move: ${elapsed.toFixed(0)} ms; position feed ${Buffer.byteLength(JSON.stringify(compact))} bytes vs full-note compatibility feed ${Buffer.byteLength(JSON.stringify(oldV2))} bytes.`);
});

test('upgrading an existing quoted v2 sync table preserves records and cursor sequence across restarts',async t=>{
  const fixture=await startFixture();t.after(()=>fixture.close());
  const credentials={username:'upgrade-owner',password:'isolated-upgrade-test-password'};
  let response=await fetch(fixture.origin+'/api/setup/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  assert.ok(response.ok,await response.clone().text());
  response=await fetch(fixture.origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  const {token}=await response.json();const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  response=await fetch(fixture.origin+'/api/sync/bootstrap?protocolVersion=2',{headers});assert.ok(response.ok);
  const [schema]=await fixture.sql("SELECT sql FROM sqlite_master WHERE name = 'sync_changes'");
  const oldSchema=schema.sql.replace(/^CREATE TABLE "sync_changes"/,'CREATE TABLE sync_changes_prior').replace(",'notePosition'",'');
  await fixture.sql(oldSchema);
  await fixture.sql('INSERT INTO sync_changes_prior SELECT * FROM sync_changes');
  await fixture.sql('DROP TABLE sync_changes');
  await fixture.sql('ALTER TABLE sync_changes_prior RENAME TO sync_changes');
  const [quoted]=await fixture.sql("SELECT sql FROM sqlite_master WHERE name = 'sync_changes'");
  assert.match(quoted.sql,/^CREATE TABLE "sync_changes"/);assert.ok(!quoted.sql.includes("'notePosition'"));
  const records=await fixture.sql('SELECT * FROM sync_changes ORDER BY sequence');assert.ok(records.length>0);
  // Represent pruned historical rows: new changes must still exceed every
  // cursor a device may already have stored, not just the remaining row IDs.
  const highWater=10000;
  await fixture.sql("UPDATE sqlite_sequence SET seq = ? WHERE name = 'sync_changes'",[highWater]);
  await fixture.restart();
  assert.deepEqual(await fixture.sql('SELECT * FROM sync_changes ORDER BY sequence'),records);
  assert.equal((await fixture.sql("SELECT seq FROM sqlite_sequence WHERE name = 'sync_changes'"))[0].seq,highWater);
  assert.ok((await fixture.sql("SELECT sql FROM sqlite_master WHERE name = 'sync_changes'"))[0].sql.includes("'notePosition'"));
  assert.equal((await fixture.sql("SELECT name FROM sqlite_master WHERE name = 'sync_changes_upgrade'")).length,0);
  response=await fetch(fixture.origin+'/api/notes',{method:'POST',headers,body:JSON.stringify({noteTitle:'After upgrade',noteBody:'Preserve this note'})});assert.ok(response.ok,await response.clone().text());
  const note=await response.json();
  response=await fetch(fixture.origin+`/api/sync/changes?protocolVersion=2&notePositions=1&cursor=${highWater}`,{headers});
  const changes=await response.json();assert.ok(changes.changes.some(change=>change.payload?.id===note.id));
  assert.ok(changes.changes.every(change=>change.sequence>highWater));
  await fixture.restart();
  response=await fetch(fixture.origin+`/api/notes/${note.id}`,{headers});assert.equal(response.status,200);assert.equal((await response.json()).noteBody,'Preserve this note');
});

test('single-note ranks handle neighbours, pin groups, ties and rebalance without changing other notes',()=>{
  const {notePositionsForOrder}=require('../shared/note-order');
  const rows=Array.from({length:500},(_,i)=>({id:i+1,syncId:`rank-${i}`,sortOrder:1000-i,pinned:i<5}));
  for(const [from,to] of [[400,10],[10,400],[200,5],[5,499],[4,0],[0,4]]) {
    const wanted=[...rows];wanted.splice(to,0,wanted.splice(from,1)[0]);
    const positions=notePositionsForOrder(wanted);assert.equal(positions.length,1);
    const ranks=new Map(positions.map(row=>[row.syncId,row.sortOrder]));
    const sorted=rows.map(row=>({...row,sortOrder:ranks.get(row.syncId)??row.sortOrder})).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.sortOrder-a.sortOrder);
    assert.deepEqual(sorted.map(row=>row.syncId),wanted.map(row=>row.syncId));
  }
  for (const movedIndex of [10,11]) {
    const adjacent=[...rows];[adjacent[10],adjacent[11]]=[adjacent[11],adjacent[10]];
    const positions=notePositionsForOrder(adjacent,Date.now(),rows[movedIndex].syncId);
    assert.equal(positions.length,1);assert.equal(positions[0].syncId,rows[movedIndex].syncId,'server and local cache must change the same note for an adjacent swap');
  }
  assert.deepEqual(notePositionsForOrder(rows),[]);
  const ties=rows.slice(5,8).map(row=>({...row,sortOrder:1}));
  const reordered=[ties[1],ties[0],ties[2]];
  assert.equal(notePositionsForOrder(reordered,2000).length,3,'tied neighbours need safe rebalancing');
  const reversed=[...rows].reverse();assert.equal(notePositionsForOrder(reversed).length,500);
});
