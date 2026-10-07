import { Injectable } from '@angular/core';
import { VaultSqliteDriverService } from './vault-sqlite-driver.service';
import { VaultIdentityService } from './vault-identity.service';
import { VaultKeyMaterialService } from './vault-key-material.service';
import { VaultIdentity, WrappedVaultKey } from './vault-types';

interface StoredKeyMetadata<T> {
  keyId: string;
  value: string;
  createdAt: string;
  updatedAt: string;
  parsed?: T;
}

export interface Kept2VaultSession {
  identity: VaultIdentity;
  unlockedAt: string;
}

@Injectable({ providedIn: 'root' })
export class VaultSessionService {
  private vmk: Uint8Array | null = null;
  private session: Kept2VaultSession | null = null;

  constructor(
    private driver: VaultSqliteDriverService,
    private identities: VaultIdentityService,
    private keyMaterial: VaultKeyMaterialService
  ) {}

  async hasLocalVault() {
    return !!await this.readMetadata<WrappedVaultKey>('passwordWrap');
  }

  isUnlocked() {
    return !!this.vmk;
  }

  currentSession() {
    return this.session;
  }

  currentVmk() {
    if (!this.vmk) throw new Error('Kept 2 vault is locked.');
    return this.vmk;
  }

  async createLocalVault(password: string) {
    if (!String(password || '').trim()) throw new Error('A vault password is required.');
    if (await this.hasLocalVault()) throw new Error('A local Kept 2 vault already exists.');

    const identity = await this.identities.loadOrCreate();
    const material = await this.keyMaterial.createForPassword(password);
    await this.driver.transaction(async () => {
      await this.writeMetadata('passwordWrap', material.passwordWrap);
      await this.writeMetadata('recoveryWrap', material.recoveryWrap);
    });
    this.vmk = material.vmk;
    this.session = {
      identity: await this.identities.markUnlocked(),
      unlockedAt: new Date().toISOString()
    };
    return {
      identity,
      recoveryCode: material.recoveryCode
    };
  }

  async unlockWithPassword(password: string) {
    const wrap = await this.requireMetadata<WrappedVaultKey>('passwordWrap');
    this.vmk = await this.keyMaterial.unwrapWithPassword(password, wrap);
    this.session = {
      identity: await this.identities.markUnlocked(),
      unlockedAt: new Date().toISOString()
    };
    return this.session;
  }

  async recoverWithCode(recoveryCode: string, newPassword?: string) {
    const wrap = await this.requireMetadata<WrappedVaultKey>('recoveryWrap');
    this.vmk = await this.keyMaterial.unwrapWithRecoveryCode(recoveryCode, wrap);
    if (newPassword) {
      await this.changePassword(newPassword);
    } else {
      this.session = {
        identity: await this.identities.markUnlocked(),
        unlockedAt: new Date().toISOString()
      };
    }
    return this.session;
  }

  async changePassword(newPassword: string) {
    if (!String(newPassword || '').trim()) throw new Error('A new vault password is required.');
    const vmk = this.currentVmk();
    const wrap = await this.keyMaterial.rewrapPassword(vmk, newPassword);
    await this.writeMetadata('passwordWrap', wrap);
    this.session = {
      identity: await this.identities.markUnlocked(),
      unlockedAt: new Date().toISOString()
    };
    return this.session;
  }

  lock() {
    this.vmk = null;
    this.session = null;
  }

  private async requireMetadata<T>(keyId: string): Promise<T> {
    const row = await this.readMetadata<T>(keyId);
    if (!row) throw new Error(`Missing Kept 2 key metadata: ${keyId}`);
    return row;
  }

  private async readMetadata<T>(keyId: string): Promise<T | null> {
    const row = await this.driver.get<StoredKeyMetadata<T>>(
      'SELECT keyId, value, createdAt, updatedAt FROM key_metadata WHERE keyId = ?',
      [keyId]
    );
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  private async writeMetadata(keyId: string, value: unknown) {
    const now = new Date().toISOString();
    const existing = await this.driver.get<{ createdAt: string }>(
      'SELECT createdAt FROM key_metadata WHERE keyId = ?',
      [keyId]
    );
    await this.driver.run(
      `INSERT INTO key_metadata (keyId, value, createdAt, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(keyId) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      [keyId, JSON.stringify(value), existing?.createdAt || now, now]
    );
  }
}
