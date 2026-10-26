const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Subject } = require('rxjs');
const { IDBFactory } = require('fake-indexeddb');
const { createStore } = require('../test-support/workspace-store.cjs');
const { startFixture } = require('../test-support/session-fixture.cjs');

function binderService(store, workspace) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/services/binders.service.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, { exports, console, localStorage: { getItem: () => null }, require(name) {
    if (name === '@angular/core') return { Injectable: () => target => target };
    if (name === 'rxjs') return require('rxjs');
    if (name.endsWith('/environment')) return { environment: { apiUrl: '/api' } };
    if (name.endsWith('/uuid')) return { createUuid: () => crypto.randomUUID() };
    throw Error(`Unexpected dependency: ${name}`);
  } });
  const sync = {
    partition: workspace.partition, writesLocally: true, cacheChanged$: new Subject(),
    commit: (type, id, value) => store.commitMutation(workspace, type, id, value)
  };
  return new exports.BindersService(store, sync, { isLocal: true });
}
const names = service => Array.from(service.items$.value, item => item.name);
async function localWorkspace(store) {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const workspace = { id, partition: `local:${id}`, mode: 'local', generation: 'first', status: 'active',
    createdAt: now, updatedAt: now, preferences: { theme: 'light', followSystemTheme: true, showPastReminders: false }, nextId: 1, revision: 0 };
  await store.saveWorkspace(workspace);
  return workspace;
}

test('local binder order survives reopening and renaming, with new binders appended', async () => {
  const database = new IDBFactory(), store = createStore(database);
  const workspace = await localWorkspace(store);
  const service = binderService(store, workspace);
  for (const name of ['Zulu', 'Alpha', 'Middle']) await service.save(name);
  assert.deepEqual(names(service), ['Alpha', 'Middle', 'Zulu']);
  const originalIdentity = service.items$.value.find(item => item.name === 'Zulu').syncId;
  await service.reorder(['Zulu', 'Alpha', 'Middle']);
  await service.save('Zebra', 'Zulu');
  assert.equal(service.items$.value[0].syncId, originalIdentity);
  await service.save('Aardvark');
  assert.deepEqual(names(service), ['Zebra', 'Alpha', 'Middle', 'Aardvark']);
  await service.delete('Middle');
  const reopened = binderService(createStore(database), workspace);
  await reopened.load();
  assert.deepEqual(names(reopened), ['Zebra', 'Alpha', 'Aardvark']);
  const backup = await store.captureBackup(workspace);
  const restoredWorkspace = { ...await localWorkspace(store), status: 'staging' };
  await store.saveWorkspace(restoredWorkspace);
  for (const row of await store.snapshotPage(backup.id, undefined, 100)) {
    if (row.store === 'binders') await store.stageRecord(restoredWorkspace, 'binder', row.record.value);
  }
  const restored = binderService(store, restoredWorkspace); await restored.load();
  assert.deepEqual(names(restored), names(reopened), 'backup records preserve the custom order on restore');
  await store.discardStaging(backup.id);
  const separate = await localWorkspace(store);
  await binderService(store, separate).save('Separate binder');
  await reopened.load();
  assert.deepEqual(names(reopened), ['Zebra', 'Alpha', 'Aardvark'], 'workspace orders remain separate');
});

test('binder order upgrades existing databases, syncs to another client and survives legacy renames', async () => {
  const fixture = await startFixture();
  let token, counter = 0;
  const password = 'isolated-binder-test-password';
  async function request(path, body, access = token, status = 200) {
    const response = await fetch(`${fixture.origin}/api${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }
  function mutation(syncId, payload, physicalMs = Date.now()) {
    const operationId = `binder-test-${++counter}`;
    return { type: 'binder.upsert', syncId, payload, operationId,
      lww: { physicalMs, logical: counter, deviceId: 'binder-test', operationId } };
  }
  const send = async (mutations, access = token) => (await request('/sync/mutations', { protocolVersion: 2, mutations }, access)).results;
  try {
    await request('/setup/admin', { username: 'owner', displayName: 'Owner', password }, undefined, 201);
    token = (await request('/auth/login', { username: 'owner', password })).token;
    await send([mutation('alpha', { name: 'Alpha' }), mutation('zulu', { name: 'Zulu' })]);
    await fixture.sql('ALTER TABLE binders DROP COLUMN sortOrder');
    await fixture.restart();
    assert.equal((await request('/sync/bootstrap?protocolVersion=2')).binders.length, 2, 'migration preserves binders');
    assert.ok((await fixture.sql('PRAGMA table_info(binders)')).some(column => column.name === 'sortOrder'));
    const cursor = (await request('/sync/changes?protocolVersion=2')).cursor;
    const stamp = Date.now() + 1000;
    const order = [mutation('zulu', { name: 'Zulu', sortOrder: 0 }, stamp), mutation('alpha', { name: 'Alpha', sortOrder: 1 }, stamp)];
    assert.ok((await send(order)).every(result => result.ok));
    const snapshot = await request('/sync/bootstrap?protocolVersion=2');
    const store = createStore(), workspace = await store.ensureServerWorkspace('second-client');
    await store.reconcile(workspace, { snapshot: { binder: snapshot.binders }, cursor: snapshot.cursor });
    const second = binderService(store, workspace); await second.load();
    assert.deepEqual(names(second), ['Zulu', 'Alpha']);
    const changes = await request(`/sync/changes?protocolVersion=2&cursor=${cursor}`);
    assert.ok(changes.changes.some(change => change.resourceSyncId === 'zulu' && change.payload.sortOrder === 0));
    const replay = await send(order);
    assert.deepEqual(await send(order), replay, 'replaying an order change is idempotent');
    await send([mutation('zulu', { name: 'Zebra' }, stamp + 1)]);
    let zebra = (await request('/sync/bootstrap?protocolVersion=2')).binders.find(item => item.syncId === 'zulu');
    assert.equal(zebra.name, 'Zebra'); assert.equal(zebra.sortOrder, 0, 'older clients need not send sortOrder on rename');
    assert.equal((await send([mutation('zulu', { name: 'Stale', sortOrder: 4 }, stamp - 1)]))[0].skipped, true);
    assert.equal((await send([mutation('zulu', { name: 'Invalid', sortOrder: -1 }, stamp + 2)]))[0].ok, false);
    const other = await request('/users', { username: 'other', displayName: 'Other', password }, token, 201);
    const otherToken = (await request('/auth/login', { username: 'other', password })).token;
    await send([mutation('zulu', { name: 'Other binder', sortOrder: 9 }, stamp + 3)], otherToken);
    zebra = (await request('/sync/bootstrap?protocolVersion=2')).binders.find(item => item.syncId === 'zulu');
    assert.equal(zebra.name, 'Zebra'); assert.equal(zebra.sortOrder, 0, 'another account cannot change this order');
    assert.ok(other.id);
  } finally { await fixture.close(); }
});
