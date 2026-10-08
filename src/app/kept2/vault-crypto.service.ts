import { Injectable } from '@angular/core';
import sodium from 'libsodium-wrappers';
import { EncryptedEnvelope, Kept2DeviceKeyPair, Kept2ResourceType, KeyGrant, LwwStamp } from './vault-types';

@Injectable({ providedIn: 'root' })
export class VaultCryptoService {
  private ready?: Promise<void>;

  async randomKey() {
    await this.ensureReady();
    return sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
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
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const plaintext = sodium.from_string(JSON.stringify(value ?? null));
    const aad = { resourceId, resourceType, keyEpoch };
    const ciphertextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      this.aadBytes(aad),
      null,
      nonce,
      key
    );
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
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      this.aadBytes(envelope.aad),
      nonce,
      key
    );
    return JSON.parse(sodium.to_string(plaintext)) as T;
  }

  async encryptBlob(resourceId: string, blob: Blob, key: Uint8Array, keyEpoch = 1) {
    await this.ensureReady();
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const plaintext = new Uint8Array(await blob.arrayBuffer());
    const aad = { resourceId, resourceType: 'blob', keyEpoch };
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      this.aadBytes(aad),
      null,
      nonce,
      key
    );
    const sealed = new Uint8Array(nonce.length + ciphertext.length);
    sealed.set(nonce, 0);
    sealed.set(ciphertext, nonce.length);
    return {
      ciphertext: new Blob([sealed], { type: 'application/octet-stream' }),
      ciphertextHash: await this.sha256Base64Url(sealed)
    };
  }

  async decryptBlob(resourceId: string, encryptedBlob: Blob, key: Uint8Array, contentType = 'application/octet-stream', keyEpoch = 1) {
    await this.ensureReady();
    const sealed = new Uint8Array(await encryptedBlob.arrayBuffer());
    const nonceLength = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    if (sealed.length <= nonceLength) throw new Error('Invalid encrypted blob.');
    const nonce = sealed.slice(0, nonceLength);
    const ciphertext = sealed.slice(nonceLength);
    const aad = { resourceId, resourceType: 'blob', keyEpoch };
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      this.aadBytes(aad),
      nonce,
      key
    );
    return new Blob([this.bytesToArrayBuffer(plaintext)], { type: contentType });
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

  async createDeviceKeyPair(deviceId: string): Promise<Kept2DeviceKeyPair> {
    await this.ensureReady();
    const pair = sodium.crypto_box_keypair();
    return {
      deviceId,
      publicKey: sodium.to_base64(pair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      privateKey: sodium.to_base64(pair.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      createdAt: new Date().toISOString()
    };
  }

  async wrapKeyForDevicePublicKey(keyToWrap: Uint8Array, recipientPublicKey: string) {
    await this.ensureReady();
    const publicKey = sodium.from_base64(recipientPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const sealed = sodium.crypto_box_seal(keyToWrap, publicKey);
    return sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  async sealJsonForPublicKey(value: unknown, recipientPublicKey: string) {
    await this.ensureReady();
    const publicKey = sodium.from_base64(recipientPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const sealed = sodium.crypto_box_seal(sodium.from_string(JSON.stringify(value ?? null)), publicKey);
    return sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  async unwrapKeyFromDeviceGrant(wrapped: string, recipientPublicKey: string, recipientPrivateKey: string) {
    await this.ensureReady();
    const sealed = sodium.from_base64(wrapped, sodium.base64_variants.URLSAFE_NO_PADDING);
    const publicKey = sodium.from_base64(recipientPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const privateKey = sodium.from_base64(recipientPrivateKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    return sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
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
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', this.bytesToArrayBuffer(value)));
    await this.ensureReady();
    return sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  private aadBytes(value: unknown) {
    return sodium.from_string(this.canonicalJson(value));
  }

  private bytesToArrayBuffer(bytes: Uint8Array) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  private canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => this.canonicalJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value as Record<string, unknown>).sort().map(key => {
        return `${JSON.stringify(key)}:${this.canonicalJson((value as Record<string, unknown>)[key])}`;
      }).join(',')}}`;
    }
    return JSON.stringify(value);
  }
}
