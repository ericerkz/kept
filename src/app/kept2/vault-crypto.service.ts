import { Injectable } from '@angular/core';
import sodium from 'libsodium-wrappers';
import { EncryptedEnvelope, Kept2ResourceType, KeyGrant, LwwStamp } from './vault-types';

@Injectable({ providedIn: 'root' })
export class VaultCryptoService {
  private ready?: Promise<void>;

  async randomKey() {
    await this.ensureReady();
    return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  }

  async encryptJson(
    resourceId: string,
    resourceType: Kept2ResourceType,
    value: unknown,
    key: Uint8Array,
    lww: LwwStamp,
    keyEpoch = 1
  ): Promise<EncryptedEnvelope> {
    await this.ensureReady();
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const plaintext = sodium.from_string(JSON.stringify(value ?? null));
    const aad = { resourceId, resourceType, keyEpoch };
    const ciphertextBytes = sodium.crypto_secretbox_easy(plaintext, nonce, key);
    return {
      resourceId,
      resourceType,
      keyEpoch,
      lww,
      ciphertext: sodium.to_base64(ciphertextBytes, sodium.base64_variants.URLSAFE_NO_PADDING),
      nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
      aad,
      ciphertextHash: await this.sha256Base64Url(ciphertextBytes),
      schemaVersion: 1
    };
  }

  async decryptJson<T>(envelope: EncryptedEnvelope, key: Uint8Array): Promise<T> {
    await this.ensureReady();
    const nonce = sodium.from_base64(envelope.nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
    const ciphertext = sodium.from_base64(envelope.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
    return JSON.parse(sodium.to_string(plaintext)) as T;
  }

  async wrapKeyWithSymmetricKey(keyToWrap: Uint8Array, wrappingKey: Uint8Array) {
    await this.ensureReady();
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(keyToWrap, nonce, wrappingKey);
    return [
      sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
      sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING)
    ].join('.');
  }

  async unwrapKeyWithSymmetricKey(wrapped: string, wrappingKey: Uint8Array) {
    await this.ensureReady();
    const [nonceValue, ciphertextValue] = String(wrapped || '').split('.');
    if (!nonceValue || !ciphertextValue) throw new Error('Invalid wrapped key.');
    const nonce = sodium.from_base64(nonceValue, sodium.base64_variants.URLSAFE_NO_PADDING);
    const ciphertext = sodium.from_base64(ciphertextValue, sodium.base64_variants.URLSAFE_NO_PADDING);
    return sodium.crypto_secretbox_open_easy(ciphertext, nonce, wrappingKey);
  }

  newGrant(input: Omit<KeyGrant, 'grantId' | 'createdAt' | 'revokedAt'>): KeyGrant {
    return {
      ...input,
      grantId: `grant-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      revokedAt: null
    };
  }

  private ensureReady() {
    this.ready ||= sodium.ready.then(() => undefined);
    return this.ready;
  }

  private async sha256Base64Url(value: Uint8Array) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
    await this.ensureReady();
    return sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING);
  }
}

