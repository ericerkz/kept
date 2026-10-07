import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createVaultKeyMaterial,
  unwrapWithPassword,
  unwrapWithRecoveryCode,
  wrapWithPassword
} = require('./kept2/key-material.js');

test('kept2 key material creates password and recovery VMK wraps', async () => {
  const material = await createVaultKeyMaterial('vault password');
  assert.equal(material.vmk.length, 32);
  assert.equal(material.backupKey.length, 32);
  assert.equal(material.recoveryKey.length, 32);
  assert.equal(material.passwordWrap.purpose, 'password');
  assert.equal(material.passwordWrap.algorithm, 'pbkdf2-sha256.secretbox');
  assert.equal(material.recoveryWrap.purpose, 'recovery');
  assert.equal(material.recoveryWrap.algorithm, 'raw-secretbox');
  assert.match(material.recoveryCode, /^kept2-recovery-/);

  const unwrappedPassword = await unwrapWithPassword('vault password', material.passwordWrap);
  const unwrappedRecovery = await unwrapWithRecoveryCode(material.recoveryCode, material.recoveryWrap);
  assert.deepEqual(Array.from(unwrappedPassword), Array.from(material.vmk));
  assert.deepEqual(Array.from(unwrappedRecovery), Array.from(material.vmk));
});

test('kept2 key material rejects wrong password and supports password change rewrap', async () => {
  const material = await createVaultKeyMaterial('old password');
  await assert.rejects(() => unwrapWithPassword('wrong password', material.passwordWrap));

  const newWrap = await wrapWithPassword(material.vmk, 'new password');
  await assert.rejects(() => unwrapWithPassword('old password', newWrap));
  const unwrapped = await unwrapWithPassword('new password', newWrap);
  assert.deepEqual(Array.from(unwrapped), Array.from(material.vmk));
});
