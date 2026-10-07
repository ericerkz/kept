import assert from 'node:assert/strict';
import test from 'node:test';
import syncCore from './kept2/sync-core.js';

const { shouldApplyLww } = syncCore;

test('kept2 three-client LWW convergence handles stale edits and tombstones', () => {
  const relay = new FakeRelay();
  const a = new FakeClient('device-a', relay);
  const b = new FakeClient('device-b', relay);
  const c = new FakeClient('device-c', relay);

  a.upsert('note-1', 'draft from a', stamp(1000, 'device-a', 'op-a-1'));
  a.push();
  b.pull();
  c.pull();

  b.upsert('note-1', 'newer from b', stamp(2000, 'device-b', 'op-b-1'));
  c.upsert('note-1', 'older offline from c', stamp(1500, 'device-c', 'op-c-stale'));
  c.push();
  b.push();
  a.pull();
  c.pull();

  assert.equal(a.value('note-1'), 'newer from b');
  assert.equal(b.value('note-1'), 'newer from b');
  assert.equal(c.value('note-1'), 'newer from b');

  a.delete('note-1', stamp(3000, 'device-a', 'op-a-delete'));
  a.push();
  b.upsert('note-1', 'stale resurrection from b', stamp(2500, 'device-b', 'op-b-stale'));
  b.push();
  b.pull();
  c.pull();

  assert.equal(a.has('note-1'), false);
  assert.equal(b.has('note-1'), false);
  assert.equal(c.has('note-1'), false);
  assert.equal(relay.resource('note-1').deleted, true);
});

class FakeClient {
  constructor(deviceId, relay) {
    this.deviceId = deviceId;
    this.relay = relay;
    this.rows = new Map();
    this.outbox = [];
    this.cursor = 0;
  }

  upsert(resourceId, value, lww) {
    this.apply({ resourceId, value, lww, deleted: false });
    this.outbox.push({ resourceId, value, lww, deleted: false });
  }

  delete(resourceId, lww) {
    this.apply({ resourceId, value: null, lww, deleted: true });
    this.outbox.push({ resourceId, value: null, lww, deleted: true });
  }

  push() {
    for (const mutation of this.outbox) this.relay.apply(mutation);
    this.outbox = [];
  }

  pull() {
    const changes = this.relay.changesSince(this.cursor);
    for (const change of changes) {
      this.apply(change);
      this.cursor = change.sequence;
    }
  }

  apply(change) {
    const existing = this.rows.get(change.resourceId);
    if (existing && !shouldApplyLww(rowLww(existing), change.lww)) return;
    this.rows.set(change.resourceId, {
      value: change.value,
      deleted: change.deleted,
      ...lwwColumns(change.lww)
    });
  }

  value(resourceId) {
    const row = this.rows.get(resourceId);
    return row && !row.deleted ? row.value : undefined;
  }

  has(resourceId) {
    const row = this.rows.get(resourceId);
    return !!row && !row.deleted;
  }
}

class FakeRelay {
  constructor() {
    this.rows = new Map();
    this.log = [];
  }

  apply(mutation) {
    const existing = this.rows.get(mutation.resourceId);
    if (existing && !shouldApplyLww(rowLww(existing), mutation.lww)) return;
    const row = {
      resourceId: mutation.resourceId,
      value: mutation.value,
      deleted: mutation.deleted,
      ...lwwColumns(mutation.lww)
    };
    this.rows.set(mutation.resourceId, row);
    this.log.push({
      sequence: this.log.length + 1,
      ...mutation
    });
  }

  changesSince(cursor) {
    return this.log.filter(change => change.sequence > cursor);
  }

  resource(resourceId) {
    return this.rows.get(resourceId);
  }
}

function stamp(physicalMs, deviceId, operationId) {
  return { physicalMs, logical: 0, deviceId, operationId };
}

function lwwColumns(lww) {
  return {
    lwwPhysicalMs: lww.physicalMs,
    lwwLogical: lww.logical,
    lwwDeviceId: lww.deviceId,
    lwwOperationId: lww.operationId
  };
}

function rowLww(row) {
  return {
    lwwPhysicalMs: row.lwwPhysicalMs,
    lwwLogical: row.lwwLogical,
    lwwDeviceId: row.lwwDeviceId,
    lwwOperationId: row.lwwOperationId
  };
}
