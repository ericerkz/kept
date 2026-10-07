import { Injectable } from '@angular/core';
import { VaultCryptoService } from './vault-crypto.service';
import { VaultSessionService } from './vault-session.service';
import { VaultSqliteDriverService } from './vault-sqlite-driver.service';
import { Kept2DeviceKeyPair, Kept2GrantPurpose, Kept2ResourceType, KeyGrant } from './vault-types';

interface StoredResourceKey {
  resourceId: string;
  resourceType: Kept2ResourceType;
  keyEpoch: number;
  wrappedKey: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class VaultResourceKeyService {
  private cache = new Map<string, Uint8Array>();

  constructor(
    private cryptoService: VaultCryptoService,
    private driver: VaultSqliteDriverService,
    private session: VaultSessionService
  ) {
    window.addEventListener('kept2-vault-locked', () => this.clearCache());
  }

  async keyFor(resourceId: string, resourceType: Kept2ResourceType) {
    const cacheKey = this.cacheKey(resourceId, resourceType);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const stored = await this.read(resourceId, resourceType);
    if (stored) {
      const key = await this.unwrapStoredKey(stored);
      this.cache.set(cacheKey, key);
      return key;
    }

    const key = await this.cryptoService.randomKey();
    const now = new Date().toISOString();
    const value: StoredResourceKey = {
      resourceId,
      resourceType,
      keyEpoch: 1,
      wrappedKey: await this.cryptoService.wrapKeyWithSymmetricKey(key, this.session.currentVmk()),
      createdAt: now,
      updatedAt: now
    };
    await this.driver.run(
      `INSERT INTO key_metadata (keyId, value, createdAt, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(keyId) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      [this.metadataKey(resourceId, resourceType), JSON.stringify(value), now, now]
    );
    this.cache.set(cacheKey, key);
    return key;
  }

  async existingKeyFor(resourceId: string, resourceType: Kept2ResourceType) {
    const cacheKey = this.cacheKey(resourceId, resourceType);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const stored = await this.read(resourceId, resourceType);
    if (!stored) throw new Error(`Missing local key for ${resourceType} ${resourceId}.`);
    const key = await this.unwrapStoredKey(stored);
    this.cache.set(cacheKey, key);
    return key;
  }

  async grantFor(vaultId: string, resourceId: string, resourceType: Kept2ResourceType, grantPurpose: Kept2GrantPurpose = 'recovery') {
    const grantId = this.grantId(vaultId, resourceId, resourceType, grantPurpose);
    const existing = await this.readGrant(grantId);
    if (existing) return existing;

    const key = await this.keyFor(resourceId, resourceType);
    const now = new Date().toISOString();
    const grant: KeyGrant = {
      grantId,
      vaultId,
      resourceId,
      resourceType,
      granteeId: `vault:${vaultId}:vmk`,
      grantPurpose,
      keyEpoch: 1,
      wrappedKey: await this.cryptoService.wrapKeyWithSymmetricKey(key, this.session.currentVmk()),
      createdAt: now,
      revokedAt: null
    };
    await this.writeGrant(grant);
    return grant;
  }

  async deviceGrantFor(
    vaultId: string,
    resourceId: string,
    resourceType: Kept2ResourceType,
    recipientDeviceId: string,
    recipientPublicKey: string
  ) {
    const grantId = this.grantId(vaultId, resourceId, resourceType, 'device', recipientDeviceId);
    const existing = await this.readGrant(grantId);
    if (existing) return existing;
    const key = await this.keyFor(resourceId, resourceType);
    const now = new Date().toISOString();
    const grant: KeyGrant = {
      grantId,
      vaultId,
      resourceId,
      resourceType,
      granteeId: `device:${recipientDeviceId}`,
      grantPurpose: 'device',
      keyEpoch: 1,
      wrappedKey: await this.cryptoService.wrapKeyForDevicePublicKey(key, recipientPublicKey),
      createdAt: now,
      revokedAt: null
    };
    await this.writeGrant(grant);
    return grant;
  }

  async publicKeyGrantFor(
    vaultId: string,
    resourceId: string,
    resourceType: Kept2ResourceType,
    grantPurpose: Extract<Kept2GrantPurpose, 'mcp' | 'calendar'>,
    granteeId: string,
    recipientPublicKey: string
  ) {
    const grantId = this.grantId(vaultId, resourceId, resourceType, grantPurpose, granteeId);
    const existing = await this.readGrant(grantId);
    if (existing) return existing;
    const key = await this.keyFor(resourceId, resourceType);
    const now = new Date().toISOString();
    const grant: KeyGrant = {
      grantId,
      vaultId,
      resourceId,
      resourceType,
      granteeId,
      grantPurpose,
      keyEpoch: 1,
      wrappedKey: await this.cryptoService.wrapKeyForDevicePublicKey(key, recipientPublicKey),
      createdAt: now,
      revokedAt: null
    };
    await this.writeGrant(grant);
    return grant;
  }

  publicKeyGrantIdFor(
    vaultId: string,
    resourceId: string,
    resourceType: Kept2ResourceType,
    grantPurpose: Extract<Kept2GrantPurpose, 'mcp' | 'calendar'>,
    granteeId: string
  ) {
    return this.grantId(vaultId, resourceId, resourceType, grantPurpose, granteeId);
  }

  async importGrant(grant: KeyGrant) {
    if (!grant || grant.revokedAt) return false;
    if (grant.grantPurpose !== 'recovery' && grant.grantPurpose !== 'device') return false;
    if (!String(grant.granteeId || '').endsWith(':vmk')) return false;
    const key = await this.cryptoService.unwrapKeyWithSymmetricKey(grant.wrappedKey, this.session.currentVmk());
    const now = new Date().toISOString();
    const value: StoredResourceKey = {
      resourceId: grant.resourceId,
      resourceType: grant.resourceType,
      keyEpoch: grant.keyEpoch || 1,
      wrappedKey: await this.cryptoService.wrapKeyWithSymmetricKey(key, this.session.currentVmk()),
      createdAt: grant.createdAt || now,
      updatedAt: now
    };
    await this.driver.run(
      `INSERT INTO key_metadata (keyId, value, createdAt, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(keyId) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      [this.metadataKey(grant.resourceId, grant.resourceType), JSON.stringify(value), value.createdAt, now]
    );
    await this.writeGrant(grant);
    this.cache.set(this.cacheKey(grant.resourceId, grant.resourceType), key);
    return true;
  }

  async importDeviceGrant(grant: KeyGrant, deviceKeyPair: Kept2DeviceKeyPair) {
    if (!grant || grant.revokedAt || grant.grantPurpose !== 'device') return false;
    if (grant.granteeId !== `device:${deviceKeyPair.deviceId}`) return false;
    const key = await this.cryptoService.unwrapKeyFromDeviceGrant(
      grant.wrappedKey,
      deviceKeyPair.publicKey,
      deviceKeyPair.privateKey
    );
    const now = new Date().toISOString();
    const value: StoredResourceKey = {
      resourceId: grant.resourceId,
      resourceType: grant.resourceType,
      keyEpoch: grant.keyEpoch || 1,
      wrappedKey: await this.cryptoService.wrapKeyWithSymmetricKey(key, this.session.currentVmk()),
      createdAt: grant.createdAt || now,
      updatedAt: now
    };
    await this.driver.run(
      `INSERT INTO key_metadata (keyId, value, createdAt, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(keyId) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      [this.metadataKey(grant.resourceId, grant.resourceType), JSON.stringify(value), value.createdAt, now]
    );
    await this.writeGrant(grant);
    this.cache.set(this.cacheKey(grant.resourceId, grant.resourceType), key);
    return true;
  }

  clearCache() {
    this.cache.clear();
  }

  private unwrapStoredKey(stored: StoredResourceKey) {
    return this.cryptoService.unwrapKeyWithSymmetricKey(stored.wrappedKey, this.session.currentVmk());
  }

  private async read(resourceId: string, resourceType: Kept2ResourceType): Promise<StoredResourceKey | null> {
    const row = await this.driver.get<{ value: string }>(
      'SELECT value FROM key_metadata WHERE keyId = ?',
      [this.metadataKey(resourceId, resourceType)]
    );
    return row ? JSON.parse(row.value) as StoredResourceKey : null;
  }

  private async readGrant(grantId: string): Promise<KeyGrant | null> {
    const row = await this.driver.get<{ value: string }>(
      'SELECT value FROM key_metadata WHERE keyId = ?',
      [this.grantMetadataKey(grantId)]
    );
    return row ? JSON.parse(row.value) as KeyGrant : null;
  }

  private async writeGrant(grant: KeyGrant) {
    const now = new Date().toISOString();
    await this.driver.run(
      `INSERT INTO key_metadata (keyId, value, createdAt, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(keyId) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      [this.grantMetadataKey(grant.grantId), JSON.stringify(grant), grant.createdAt || now, now]
    );
  }

  private metadataKey(resourceId: string, resourceType: Kept2ResourceType) {
    return `resourceKey:${resourceType}:${resourceId}`;
  }

  private grantMetadataKey(grantId: string) {
    return `keyGrant:${grantId}`;
  }

  private grantId(
    vaultId: string,
    resourceId: string,
    resourceType: Kept2ResourceType,
    grantPurpose: Kept2GrantPurpose,
    granteeId = ''
  ) {
    return `grant-${grantPurpose}-${vaultId}-${resourceType}-${resourceId}-${granteeId}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 180);
  }

  private cacheKey(resourceId: string, resourceType: Kept2ResourceType) {
    return `${resourceType}:${resourceId}`;
  }
}
