import { Injectable } from '@angular/core';
import sodium from 'libsodium-wrappers';
import { VaultKeyMaterial, VaultKeyWrapPurpose, WrappedVaultKey } from './vault-types';
import { VaultCryptoService } from './vault-crypto.service';

const PASSWORD_WRAP_ITERATIONS = 310000;

@Injectable({ providedIn: 'root' })
export class VaultKeyMaterialService {
  constructor(private cryptoService: VaultCryptoService) {}

  async createForPassword(password: string): Promise<VaultKeyMaterial> {
    await sodium.ready;
    const vmk = await this.cryptoService.randomKey();
    const backupKey = await this.cryptoService.randomKey();
    const recoveryKey = await this.cryptoService.randomKey();
    const passwordWrap = await this.wrapWithPassword(vmk, password);
    const recoveryWrap = await this.wrapWithRawKey(vmk, recoveryKey, 'recovery');
    return {
      vmk,
      backupKey,
      recoveryKey,
      passwordWrap,
      recoveryWrap,
      recoveryCode: this.encodeRecoveryCode(recoveryKey)
    };
  }

  async unwrapWithPassword(password: string, wrap: WrappedVaultKey) {
    if (wrap.algorithm !== 'pbkdf2-sha256.secretbox') throw new Error('This key wrap is not password based.');
    if (!wrap.salt || !wrap.iterations) throw new Error('Password key wrap is missing KDF metadata.');
    const key = await this.derivePasswordKey(password, wrap.salt, wrap.iterations);
    return this.cryptoService.unwrapKeyWithSymmetricKey(wrap.wrappedKey, key);
  }

  async unwrapWithRecoveryCode(recoveryCode: string, wrap: WrappedVaultKey) {
    if (wrap.algorithm !== 'raw-secretbox') throw new Error('This key wrap is not recovery based.');
    const key = this.decodeRecoveryCode(recoveryCode);
    return this.cryptoService.unwrapKeyWithSymmetricKey(wrap.wrappedKey, key);
  }

  async rewrapPassword(vmk: Uint8Array, newPassword: string) {
    return this.wrapWithPassword(vmk, newPassword);
  }

  private async wrapWithPassword(vmk: Uint8Array, password: string): Promise<WrappedVaultKey> {
    const salt = sodium.to_base64(
      sodium.randombytes_buf(16),
      sodium.base64_variants.URLSAFE_NO_PADDING
    );
    const key = await this.derivePasswordKey(password, salt, PASSWORD_WRAP_ITERATIONS);
    return {
      wrapId: `wrap-${crypto.randomUUID()}`,
      purpose: 'password',
      algorithm: 'pbkdf2-sha256.secretbox',
      salt,
      iterations: PASSWORD_WRAP_ITERATIONS,
      wrappedKey: await this.cryptoService.wrapKeyWithSymmetricKey(vmk, key),
      createdAt: new Date().toISOString()
    };
  }

  private async wrapWithRawKey(vmk: Uint8Array, rawKey: Uint8Array, purpose: VaultKeyWrapPurpose): Promise<WrappedVaultKey> {
    return {
      wrapId: `wrap-${crypto.randomUUID()}`,
      purpose,
      algorithm: 'raw-secretbox',
      salt: null,
      iterations: null,
      wrappedKey: await this.cryptoService.wrapKeyWithSymmetricKey(vmk, rawKey),
      createdAt: new Date().toISOString()
    };
  }

  private async derivePasswordKey(password: string, salt: string, iterations: number) {
    const encoder = new TextEncoder();
    const imported = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits({
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: this.bytesToArrayBuffer(sodium.from_base64(salt, sodium.base64_variants.URLSAFE_NO_PADDING)),
      iterations
    }, imported, 256);
    return new Uint8Array(bits);
  }

  private encodeRecoveryCode(recoveryKey: Uint8Array) {
    return `kept2-recovery-${sodium.to_base64(recoveryKey, sodium.base64_variants.URLSAFE_NO_PADDING)}`;
  }

  private decodeRecoveryCode(recoveryCode: string) {
    const encoded = String(recoveryCode || '').trim().replace(/^kept2-recovery-/, '');
    return sodium.from_base64(encoded, sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  private bytesToArrayBuffer(bytes: Uint8Array) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
