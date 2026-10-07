import { Injectable } from '@angular/core';
import { VaultCryptoService } from './vault-crypto.service';
import { VaultSessionService } from './vault-session.service';
import { VaultSqliteDriverService } from './vault-sqlite-driver.service';
import { Kept2ResourceType } from './vault-types';

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
      const key = await this.cryptoService.unwrapKeyWithSymmetricKey(stored.wrappedKey, this.session.currentVmk());
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

  clearCache() {
    this.cache.clear();
  }

  private async read(resourceId: string, resourceType: Kept2ResourceType): Promise<StoredResourceKey | null> {
    const row = await this.driver.get<{ value: string }>(
      'SELECT value FROM key_metadata WHERE keyId = ?',
      [this.metadataKey(resourceId, resourceType)]
    );
    return row ? JSON.parse(row.value) as StoredResourceKey : null;
  }

  private metadataKey(resourceId: string, resourceType: Kept2ResourceType) {
    return `resourceKey:${resourceType}:${resourceId}`;
  }

  private cacheKey(resourceId: string, resourceType: Kept2ResourceType) {
    return `${resourceType}:${resourceId}`;
  }
}
