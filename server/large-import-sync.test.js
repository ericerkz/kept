const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('Takeout imports keep canonical content without duplicate source fields; old data and replay receipts are cleaned safely', async t => {
  const fixture = await startFixture(); t.after(() => fixture.close());
  let token;
  async function api(route, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(fixture.origin + '/api' + route, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  }
  const credentials = { username: 'owner', password: 'large-import-test-password' };
  await api('/setup/admin', credentials); token = (await api('/auth/login', credentials)).token;
  const source = { title: 'Imported checklist', color: 'TEAL', textContent: 'Before the list', textContentHtml: '<p>Duplicate source</p>',
    listContent: [{ text: 'First', isChecked: false }, { text: 'Nested', isChecked: true, indentLevel: 1 }],
    isPinned: true, isArchived: true, isTrashed: false, labels: [{ name: 'Imported label' }],
    createdTimestampUsec: 1500000000000000, userEditedTimestampUsec: 1600000000000000,
    annotations: [{ url: 'https://example.test/kept', title: 'Useful link' }], customExtension: { preserve: true },
    attachments: [{ filePath: 'photo.png', mimetype: 'image/png' }] };
  const zip = new AdmZip(); zip.addFile('Takeout/Keep/note.json', Buffer.from(JSON.stringify(source)));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64');
  zip.addFile('Takeout/Keep/photo.png', png);
  async function importArchive() {
    const form = new FormData(); form.append('takeout', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'synthetic-takeout.zip');
    const response = await fetch(fixture.origin + '/api/import/google-takeout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    assert.equal(response.status, 200); return response.json();
  }
  assert.equal((await importArchive()).imported, 1);
  const imported = (await api('/sync/bootstrap?protocolVersion=2')).notes.find(note => note.noteTitle === source.title);
  for (const field of require('../shared/takeout-source-fields.json')) assert.equal(Object.hasOwn(imported, field), false, field);
  assert.match(imported.noteBody, /Before the list/); assert.match(imported.noteBody, /https:\/\/example.test\/kept/);
  assert.equal(imported.checkBoxes[0].data, 'First'); assert.equal(imported.checkBoxes[1].done, true); assert.equal(imported.checkBoxes[1].indentLevel, 1);
  assert.equal(imported.archived, true); assert.equal(imported.pinned, true); assert.equal(imported.labels[0].name, 'Imported label');
  assert.equal(imported.createdAt, new Date(source.createdTimestampUsec / 1000).toISOString());
  assert.equal(imported.updatedAt, new Date(source.userEditedTimestampUsec / 1000).toISOString());
  assert.deepEqual(imported.annotations, source.annotations); assert.deepEqual(imported.customExtension, source.customExtension);
  const image = await fetch(fixture.origin + imported.images[0].dataUrl, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await importArchive()).deduped, 1);

  const mutation = { operationId: 'legacy-edit', type: 'note.upsert', syncId: imported.syncId,
    payload: { ...source, ...imported, noteTitle: 'Canonical edited title', pattern: 'travel' },
    lww: { physicalMs: Date.now(), logical: 0, deviceId: 'legacy-client', operationId: 'legacy-edit' } };
  const result = (await api('/sync/mutations', { protocolVersion: 2, responseMode: 'ack', mutations: [mutation] })).results[0];
  assert.equal(result.ok, true); assert.equal(result.canonical.listContent, undefined);
  const [before] = await fixture.sql('SELECT * FROM notes WHERE id = ?', [imported.id]);
  const [receipt] = await fixture.sql('SELECT * FROM workspace_operations WHERE operationId = ?', [mutation.operationId]);
  const [cursor] = await fixture.sql('SELECT MAX(sequence) AS sequence FROM sync_changes');
  const legacy = { ...result.canonical, ...source };
  await fixture.sql('UPDATE notes SET extraFields = ? WHERE id = ?', [JSON.stringify({ ...source, pattern: 'travel' }), imported.id]);
  await fixture.sql("UPDATE sync_changes SET payload = ? WHERE resourceType = 'note' AND resourceSyncId = ?", [JSON.stringify(legacy), imported.syncId]);
  await fixture.sql('UPDATE workspace_operations SET result = ? WHERE operationId = ?', [JSON.stringify({ ...result, canonical: legacy, payload: legacy }), mutation.operationId]);
  await fixture.sql("DELETE FROM app_settings WHERE key = 'takeoutSourceFieldsRemoved'");
  await fixture.restart();
  const [after] = await fixture.sql('SELECT * FROM notes WHERE id = ?', [imported.id]);
  for (const field of ['noteTitle', 'noteBody', 'checkBoxes', 'images', 'createdAt', 'updatedAt', 'syncId', 'lwwPhysicalMs', 'lwwLogical', 'lwwDeviceId', 'lwwOperationId']) assert.equal(after[field], before[field], field);
  const extras = JSON.parse(after.extraFields); assert.equal(extras.listContent, undefined); assert.equal(extras.textContentHtml, undefined);
  assert.equal(extras.pattern, 'travel'); assert.deepEqual(extras.customExtension, source.customExtension);
  assert.deepEqual((await fixture.sql('SELECT MAX(sequence) AS sequence FROM sync_changes'))[0], cursor);
  const [cleanReceipt] = await fixture.sql('SELECT * FROM workspace_operations WHERE operationId = ?', [mutation.operationId]);
  assert.equal(cleanReceipt.fingerprint, receipt.fingerprint); assert.equal(JSON.parse(cleanReceipt.result).canonical.listContent, undefined);
  const replay = await api('/sync/mutations', { protocolVersion: 2, responseMode: 'ack', mutations: [mutation] });
  assert.equal(replay.results[0].ok, true); assert.equal(replay.results[0].canonical.id, imported.id);
  assert.equal(replay.results[0].canonical.listContent, undefined);
  const changes = await api('/sync/changes?protocolVersion=2&cursor=0');
  assert.ok(changes.changes.filter(change => change.resourceType === 'note').every(change => !change.payload?.listContent));
});

test('ack-only edits/archive/reorders remain small for a large library; legacy snapshots and paged recovery still work', async t => {
  const fixture = await startFixture(); t.after(() => fixture.close());
  let token, counter = 0;
  async function api(route, body, method = body ? 'POST' : 'GET', access = token) {
    const response = await fetch(fixture.origin + '/api' + route, { method,
      headers: { ...(access ? { Authorization: `Bearer ${access}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  }
  const credentials = { username: 'owner', password: 'large-library-test-password' };
  await api('/setup/admin', credentials); token = (await api('/auth/login', credentials)).token;
  const [owner] = await fixture.sql("SELECT id FROM users WHERE username = 'owner'");
  const notes = Array.from({ length: 2138 }, (_, i) => ({ id: `large-${i}`, title: `Synthetic ${i}`, body: 'Text '.repeat(80) }));
  await fixture.sql(`INSERT INTO notes(ownerUserId,syncId,noteTitle,noteBody,archived,createdAt,updatedAt)
    SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.title'),json_extract(value,'$.body'),1,?,? FROM json_each(?)`,
    [owner.id, new Date().toISOString(), new Date().toISOString(), JSON.stringify(notes)]);
  const boot = await api('/sync/bootstrap?protocolVersion=2'); assert.ok(boot.notes.length >= 2138);
  const mutation = (type, syncId, payload) => ({ type, syncId, payload, operationId: `operation-${++counter}`,
    lww: { physicalMs: Date.now(), logical: counter, deviceId: 'test', operationId: `operation-${counter}` } });
  const send = (operations, mode = 'ack', protocolVersion = 2) => api('/sync/mutations', { protocolVersion, responseMode: mode, mutations: operations });
  const remote = await send([mutation('note.upsert', 'large-1', { noteTitle: 'Edited on another device', archived: true })]);
  const edit = mutation('note.upsert', 'large-0', { noteTitle: 'Edited here', archived: false });
  const edited = await send([edit]); assert.equal(edited.results[0].ok, true); assert.equal(edited.results[0].canonical.archived, false);
  assert.equal(edited.snapshot, undefined); assert.ok(JSON.stringify(edited).length < 20000);
  assert.equal(remote.snapshot, undefined);
  assert.deepEqual((await send([edit])).results, edited.results, 'lost responses replay without duplicate writes');
  const archived = await send([mutation('note.upsert', 'large-0', { archived: true })]);
  assert.equal(archived.results[0].canonical.archived, true);
  const order = await send([mutation('note.reorder', 'order', { syncIds: ['large-1', 'large-0'] })]);
  assert.equal(order.snapshot, undefined); assert.equal(order.results[0].ok, true);
  let cursor = boot.cursor, hasMore = true; const received = [];
  while (hasMore) {
    const page = await api(`/sync/changes?protocolVersion=2&cursor=${cursor}&limit=1`);
    received.push(...page.changes); assert.ok(page.cursor >= cursor); cursor = page.cursor; hasMore = page.hasMore;
  }
  assert.ok(received.some(change => change.payload?.noteTitle === 'Edited on another device'));
  assert.ok(received.some(change => change.payload?.noteTitle === 'Edited here'));
  assert.equal((await api('/sync/changes?protocolVersion=2&cursor=' + cursor)).changes.length, 0);
  // Explicitly omit the capability, as existing mobile bundles do.
  const compatibility = await api('/sync/mutations', { protocolVersion: 2, mutations: [mutation('note.upsert', 'large-0', { archived: true })] });
  assert.ok(compatibility.snapshot.notes.length >= 2138);
  assert.ok(JSON.stringify(compatibility).length > JSON.stringify(edited).length * 50);
  t.diagnostic(`2,138-note fixture: single-edit acknowledgement ${Buffer.byteLength(JSON.stringify(edited))} bytes; compatible full snapshot ${Buffer.byteLength(JSON.stringify(compatibility))} bytes.`);
  const v1 = await send([mutation('note.upsert', 'large-0', { archived: false })], 'ack', 1);
  assert.ok(v1.snapshot.notes.length >= 2138, 'v1 ignores the v2-only response capability');
  await api('/users', { username: 'other', password: credentials.password, role: 'user' });
  const other = (await api('/auth/login', { username: 'other', password: credentials.password })).token;
  const denied = await api('/sync/mutations', { protocolVersion: 2, responseMode: 'ack', mutations: [mutation('note.upsert', 'large-0', { noteTitle: 'Denied' })] }, 'POST', other);
  assert.equal(denied.results[0].ok, false);
  const privateChanges = await api('/sync/changes?protocolVersion=2&cursor=0', undefined, 'GET', other);
  assert.ok(privateChanges.changes.every(change => change.resourceType !== 'note'));
});
