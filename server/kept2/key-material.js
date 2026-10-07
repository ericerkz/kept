const { webcrypto } = require('crypto');
const sodium = require('libsodium-wrappers');

const PASSWORD_WRAP_ITERATIONS = 310000;

async function createVaultKeyMaterial(password) {
  await sodium.ready;
  const vmk = randomKey();
  const backupKey = randomKey();
  const recoveryKey = randomKey();
  const passwordWrap = await wrapWithPassword(vmk, password);
  const recoveryWrap = await wrapWithRawKey(vmk, recoveryKey, 'recovery');
  return {
    vmk,
    backupKey,
    recoveryKey,
    passwordWrap,
    recoveryWrap,
    recoveryCode: encodeRecoveryCode(recoveryKey)
  };
}

async function unwrapWithPassword(password, wrap) {
  if (wrap.algorithm !== 'pbkdf2-sha256.secretbox') throw new Error('This key wrap is not password based.');
  if (!wrap.salt || !wrap.iterations) throw new Error('Password key wrap is missing KDF metadata.');
  const key = await derivePasswordKey(password, wrap.salt, wrap.iterations);
  return unwrapKey(wrap.wrappedKey, key);
}

async function unwrapWithRecoveryCode(recoveryCode, wrap) {
  if (wrap.algorithm !== 'raw-secretbox') throw new Error('This key wrap is not recovery based.');
  return unwrapKey(wrap.wrappedKey, decodeRecoveryCode(recoveryCode));
}

async function wrapWithPassword(vmk, password) {
  const salt = base64Url(sodium.randombytes_buf(16));
  const key = await derivePasswordKey(password, salt, PASSWORD_WRAP_ITERATIONS);
  return {
    wrapId: `wrap-${webcrypto.randomUUID()}`,
    purpose: 'password',
    algorithm: 'pbkdf2-sha256.secretbox',
    salt,
    iterations: PASSWORD_WRAP_ITERATIONS,
    wrappedKey: wrapKey(vmk, key),
    createdAt: new Date().toISOString()
  };
}

async function wrapWithRawKey(vmk, rawKey, purpose) {
  return {
    wrapId: `wrap-${webcrypto.randomUUID()}`,
    purpose,
    algorithm: 'raw-secretbox',
    salt: null,
    iterations: null,
    wrappedKey: wrapKey(vmk, rawKey),
    createdAt: new Date().toISOString()
  };
}

async function derivePasswordKey(password, salt, iterations) {
  const imported = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password || '')),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await webcrypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: sodium.from_base64(salt, sodium.base64_variants.URLSAFE_NO_PADDING),
    iterations
  }, imported, 256);
  return new Uint8Array(bits);
}

function wrapKey(keyToWrap, wrappingKey) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(keyToWrap, nonce, wrappingKey);
  return `${base64Url(nonce)}.${base64Url(ciphertext)}`;
}

function unwrapKey(wrapped, wrappingKey) {
  const [nonceValue, ciphertextValue] = String(wrapped || '').split('.');
  if (!nonceValue || !ciphertextValue) throw new Error('Invalid wrapped key.');
  return sodium.crypto_secretbox_open_easy(
    sodium.from_base64(ciphertextValue, sodium.base64_variants.URLSAFE_NO_PADDING),
    sodium.from_base64(nonceValue, sodium.base64_variants.URLSAFE_NO_PADDING),
    wrappingKey
  );
}

function randomKey() {
  return sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
}

function encodeRecoveryCode(recoveryKey) {
  return `kept2-recovery-${base64Url(recoveryKey)}`;
}

function decodeRecoveryCode(recoveryCode) {
  return sodium.from_base64(
    String(recoveryCode || '').trim().replace(/^kept2-recovery-/, ''),
    sodium.base64_variants.URLSAFE_NO_PADDING
  );
}

function base64Url(bytes) {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

module.exports = {
  createVaultKeyMaterial,
  decodeRecoveryCode,
  encodeRecoveryCode,
  unwrapWithPassword,
  unwrapWithRecoveryCode,
  wrapWithPassword
};
