import assert from 'node:assert/strict';
import test from 'node:test';
import sodium from 'libsodium-wrappers';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { encodeOutboxEntry, removableOperationIds, resourceTypeForLocalKind } = require('./kept2/encrypted-sync.js');

test('kept2 encrypted sync maps local resource kinds to encrypted resource types', () => {
  assert.equal(resourceTypeForLocalKind('note'), 'note.content');
  assert.equal(resourceTypeForLocalKind('reminder'), 'reminder');
  assert.equal(resourceTypeForLocalKind('attachment'), 'attachment');
  assert.equal(resourceTypeForLocalKind('unknown'), 'note.content');
});

test('kept2 encrypted sync encodes upserts as content-blind envelopes', async () => {
  await sodium.ready;
  const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const entry = {
    operationId: 'op-1',
    mutationType: 'resource.upsert',
    resourceId: 'note-1',
    payload: {
      localResourceKind: 'note',
      value: {
        title: 'secret title',
        body: 'secret body'
      }
    },
    lww: { physicalMs: 1, logical: 0, deviceId: 'device-a', operationId: 'op-1' },
    createdAt: '2026-01-01T00:00:00.000Z',
    attempts: 0
  };
  const encoded = await encodeOutboxEntry(entry, async ({ resourceId, resourceType, value, lww }) => {
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const plaintext = sodium.from_string(JSON.stringify(value));
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      sodium.from_string(JSON.stringify({ resourceId, resourceType })),
      null,
      nonce,
      key
    );
    return {
      resourceId,
      resourceType,
      keyEpoch: 1,
      lww,
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
      nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
      aad: { resourceId, resourceType },
      ciphertextHash: 'hash',
      schemaVersion: 1
    };
  }, async () => key);

  assert.equal(encoded.payload.envelope.resourceType, 'note.content');
  assert.equal(JSON.stringify(encoded).includes('secret title'), false);
  assert.equal(JSON.stringify(encoded).includes('secret body'), false);
});

test('kept2 encrypted sync encodes deletes without plaintext payloads and removes successful receipts', async () => {
  const encoded = await encodeOutboxEntry({
    operationId: 'op-delete',
    mutationType: 'resource.delete',
    resourceId: 'reminder-1',
    payload: {
      localResourceKind: 'reminder',
      value: { title: 'do not send this' }
    },
    lww: { physicalMs: 1, logical: 0, deviceId: 'device-a', operationId: 'op-delete' },
    createdAt: '2026-01-01T00:00:00.000Z',
    attempts: 0
  }, async () => {
    throw new Error('delete should not encrypt plaintext values');
  }, async () => new Uint8Array());
  assert.deepEqual(encoded.payload, { resourceType: 'reminder' });
  assert.deepEqual(removableOperationIds([
    { ok: true, operationId: 'op-a' },
    { ok: false, operationId: 'op-b' },
    { ok: true, operationId: 'op-c', skipped: true }
  ]), ['op-a', 'op-c']);
});
