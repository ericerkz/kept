import assert from 'node:assert/strict';
import test from 'node:test';
import syncCore from './kept2/sync-core.js';

const { compareLwwStamp, shouldApplyLww } = syncCore;

test('kept2 LWW ordering prefers newer physical time', () => {
  assert.equal(
    compareLwwStamp(
      { physicalMs: 20, logical: 0, deviceId: 'a', operationId: 'a' },
      { physicalMs: 10, logical: 99, deviceId: 'z', operationId: 'z' }
    ),
    1
  );
});

test('kept2 LWW ordering has deterministic tie breakers', () => {
  assert.equal(
    compareLwwStamp(
      { physicalMs: 10, logical: 2, deviceId: 'b', operationId: 'a' },
      { physicalMs: 10, logical: 2, deviceId: 'a', operationId: 'z' }
    ),
    1
  );
  assert.equal(
    compareLwwStamp(
      { physicalMs: 10, logical: 2, deviceId: 'a', operationId: 'z' },
      { physicalMs: 10, logical: 2, deviceId: 'a', operationId: 'a' }
    ),
    1
  );
});

test('kept2 stale mutations do not apply over an existing row', () => {
  const existing = {
    lwwPhysicalMs: 5000,
    lwwLogical: 0,
    lwwDeviceId: 'device-b',
    lwwOperationId: 'op-b'
  };
  assert.equal(shouldApplyLww(existing, {
    physicalMs: 4000,
    logical: 99,
    deviceId: 'device-z',
    operationId: 'op-z'
  }), false);
  assert.equal(shouldApplyLww(existing, {
    physicalMs: 6000,
    logical: 0,
    deviceId: 'device-a',
    operationId: 'op-a'
  }), true);
});
