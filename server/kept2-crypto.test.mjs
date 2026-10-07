import assert from 'node:assert/strict';
import test from 'node:test';
import sodium from 'libsodium-wrappers';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function encryptJson(value, aad) {
  await sodium.ready;
  const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plaintext = sodium.from_string(JSON.stringify(value));
  const aadBytes = sodium.from_string(canonicalJson(aad));
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aadBytes, null, nonce, key);
  return { key, nonce, ciphertext, aad };
}

test('kept2 envelopes hide plaintext note content', async () => {
  const note = {
    title: 'private title',
    body: 'the secret body should never be visible server-side',
    labels: ['personal']
  };
  const encrypted = await encryptJson(note, {
    resourceId: 'note-secret',
    resourceType: 'note.content',
    keyEpoch: 1
  });
  const encoded = sodium.to_base64(encrypted.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
  assert.equal(encoded.includes('private title'), false);
  assert.equal(encoded.includes('secret body'), false);
});

test('kept2 envelope aad is authenticated', async () => {
  const encrypted = await encryptJson({ body: 'hello' }, {
    resourceId: 'note-a',
    resourceType: 'note.content',
    keyEpoch: 1
  });
  const wrongAad = sodium.from_string(canonicalJson({
    resourceId: 'note-b',
    resourceType: 'note.content',
    keyEpoch: 1
  }));
  assert.throws(() => {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      encrypted.ciphertext,
      wrongAad,
      encrypted.nonce,
      encrypted.key
    );
  });
});

test('kept2 key wrapping round trips and rejects the wrong wrapping key', async () => {
  await sodium.ready;
  const keyToWrap = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const wrappingKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const wrongKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const wrapped = sodium.crypto_secretbox_easy(keyToWrap, nonce, wrappingKey);
  const unwrapped = sodium.crypto_secretbox_open_easy(wrapped, nonce, wrappingKey);
  assert.deepEqual(Array.from(unwrapped), Array.from(keyToWrap));
  assert.throws(() => sodium.crypto_secretbox_open_easy(wrapped, nonce, wrongKey));
});
