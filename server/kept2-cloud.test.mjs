import assert from 'node:assert/strict';
import test from 'node:test';
import syncCore from './kept2/sync-core.js';

const { shouldApplyLww } = syncCore;

test('kept2 cloud relay contract stays content-blind', () => {
  const mutation = cloudMutation({
    resourceId: 'note-cloud',
    operationId: 'op-cloud-1',
    ciphertext: 'opaque-ciphertext',
    aad: { resourceId: 'note-cloud', resourceType: 'note.content' }
  });

  assert.equal(JSON.stringify(mutation).includes('private title'), false);
  assert.equal(JSON.stringify(mutation).includes('secret body'), false);
  assert.equal(mutation.payload.envelope.resourceType, 'note.content');
  assert.equal(mutation.payload.envelope.ciphertext, 'opaque-ciphertext');
});

test('kept2 cloud idempotency rejects operation id reuse with different encrypted payloads', () => {
  const receipts = new Map();
  const first = applyCloudMutation(receipts, cloudMutation({
    resourceId: 'note-cloud',
    operationId: 'op-retry',
    ciphertext: 'opaque-a'
  }));
  const retry = applyCloudMutation(receipts, cloudMutation({
    resourceId: 'note-cloud',
    operationId: 'op-retry',
    ciphertext: 'opaque-a'
  }));
  const conflict = applyCloudMutation(receipts, cloudMutation({
    resourceId: 'note-cloud',
    operationId: 'op-retry',
    ciphertext: 'opaque-b'
  }));

  assert.deepEqual(first, { ok: true, skipped: false });
  assert.deepEqual(retry, { ok: true, skipped: true });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /reused/);
});

test('kept2 cloud grant policy blocks remote MCP unless explicitly enabled', () => {
  const mcpGrant = {
    operationId: 'op-grant-mcp',
    mutationType: 'keyGrant.upsert',
    resourceId: 'grant-mcp',
    payload: {
      grant: {
        grantId: 'grant-mcp',
        resourceId: 'note-cloud',
        resourceType: 'note.content',
        granteeId: 'remote-mcp',
        grantPurpose: 'mcp',
        keyEpoch: 1,
        wrappedKey: 'opaque-wrapped-key'
      }
    }
  };

  assert.equal(allowCloudGrant(mcpGrant, { remoteMcpEnabled: false }).ok, false);
  assert.equal(allowCloudGrant(mcpGrant, { remoteMcpEnabled: true }).ok, true);
});

test('kept2 cloud LWW contract converges across delayed devices', () => {
  let row = null;
  const stale = cloudMutation({
    resourceId: 'note-cloud',
    operationId: 'op-stale',
    ciphertext: 'older',
    lww: { physicalMs: 10, logical: 0, deviceId: 'device-a', operationId: 'op-stale' }
  });
  const newer = cloudMutation({
    resourceId: 'note-cloud',
    operationId: 'op-newer',
    ciphertext: 'newer',
    lww: { physicalMs: 20, logical: 0, deviceId: 'device-b', operationId: 'op-newer' }
  });

  row = applyLwwRow(row, newer.payload.envelope);
  row = applyLwwRow(row, stale.payload.envelope);

  assert.equal(row.ciphertext, 'newer');
});

function cloudMutation({
  resourceId,
  operationId,
  ciphertext,
  aad = { resourceId, resourceType: 'note.content' },
  lww = { physicalMs: 1, logical: 0, deviceId: 'device-a', operationId }
}) {
  return {
    operationId,
    mutationType: 'resource.upsert',
    resourceId,
    payload: {
      envelope: {
        resourceId,
        resourceType: 'note.content',
        keyEpoch: 1,
        lww,
        ciphertext,
        nonce: 'opaque-nonce',
        aad,
        ciphertextHash: `hash-${ciphertext}`,
        schemaVersion: 1
      }
    },
    lww,
    createdAt: '2026-01-01T00:00:00.000Z',
    attempts: 0
  };
}

function applyCloudMutation(receipts, mutation) {
  const hash = JSON.stringify({
    mutationType: mutation.mutationType,
    resourceId: mutation.resourceId,
    payload: mutation.payload,
    lww: mutation.lww
  });
  const existing = receipts.get(mutation.operationId);
  if (existing) {
    if (existing !== hash) return { ok: false, skipped: false, error: 'Operation id was reused with different payload.' };
    return { ok: true, skipped: true };
  }
  receipts.set(mutation.operationId, hash);
  return { ok: true, skipped: false };
}

function allowCloudGrant(mutation, options) {
  const purpose = String(mutation.payload?.grant?.grantPurpose || '');
  if (purpose === 'mcp' && options.remoteMcpEnabled !== true) {
    return { ok: false, error: 'Remote MCP access is disabled for this account.' };
  }
  return { ok: true };
}

function applyLwwRow(existing, envelope) {
  if (existing && !shouldApplyLww(existing, envelope.lww)) return existing;
  return {
    ciphertext: envelope.ciphertext,
    lwwPhysicalMs: envelope.lww.physicalMs,
    lwwLogical: envelope.lww.logical,
    lwwDeviceId: envelope.lww.deviceId,
    lwwOperationId: envelope.lww.operationId
  };
}
