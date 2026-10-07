import { Injectable } from '@angular/core';
import { LocalFirstVaultService } from './local-first-vault.service';
import { Kept2OutboxEntry, Kept2ResourceType, KeyGrant, SyncTransport, VaultDevicePublicKey } from './vault-types';
import { VaultCryptoService } from './vault-crypto.service';
import { VaultPlatformSecretService } from './vault-platform-secret.service';
import { VaultResourceKeyService } from './vault-resource-key.service';
import { VaultSessionService } from './vault-session.service';
import { VaultSqliteDriverService } from './vault-sqlite-driver.service';

interface StoredDeviceKeyPair {
  deviceId: string;
  publicKey: string;
  wrappedPrivateKey: string;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class VaultDevicePairingService {
  private cachedPrivateKeys = new Map<string, string>();

  constructor(
    private crypto: VaultCryptoService,
    private driver: VaultSqliteDriverService,
    private localVault: LocalFirstVaultService,
    private platformSecret: VaultPlatformSecretService,
    private resourceKeys: VaultResourceKeyService,
    private session: VaultSessionService
  ) {
    window.addEventListener('kept2-vault-locked', () => this.cachedPrivateKeys.clear());
  }

  async ensureLocalDeviceKeyPair() {
    const session = this.session.currentSession();
    if (!session) throw new Error('Kept 2 vault is locked.');
    const existing = await this.readStoredPair(session.identity.deviceId);
    if (existing) {
      return {
        deviceId: existing.deviceId,
        publicKey: existing.publicKey,
        privateKey: await this.privateKeyFor(existing),
        createdAt: existing.createdAt
      };
    }
    const pair = await this.crypto.createDeviceKeyPair(session.identity.deviceId);
    const stored: StoredDeviceKeyPair = {
      deviceId: pair.deviceId,
      publicKey: pair.publicKey,
      wrappedPrivateKey: await this.wrapPrivateKey(pair.privateKey),
      createdAt: pair.createdAt
    };
    await this.writeStoredPair(stored);
    this.cachedPrivateKeys.set(pair.deviceId, pair.privateKey);
    return pair;
  }

  async registerThisDevice(transport: SyncTransport, deviceLabel = '') {
    const session = this.session.currentSession();
    if (!session) throw new Error('Kept 2 vault is locked.');
    if (!transport.registerDevice) throw new Error('This sync transport cannot register devices.');
    const pair = await this.ensureLocalDeviceKeyPair();
    return transport.registerDevice(session.identity.vaultId, pair.deviceId, pair.publicKey, deviceLabel);
  }

  async listRemoteDevices(transport: SyncTransport) {
    const session = this.session.currentSession();
    if (!session) throw new Error('Kept 2 vault is locked.');
    if (!transport.listDevices) return [];
    return transport.listDevices(session.identity.vaultId);
  }

  async grantLocalResourcesToDevice(transport: SyncTransport, device: VaultDevicePublicKey) {
    const session = this.session.currentSession();
    if (!session) throw new Error('Kept 2 vault is locked.');
    const vaultId = session.identity.vaultId;
    const mutations: Kept2OutboxEntry[] = [];
    const createdAt = new Date().toISOString();
    const lww = {
      physicalMs: Date.now(),
      logical: 0,
      deviceId: session.identity.deviceId,
      operationId: `grant-device-${crypto.randomUUID()}`
    };

    const addGrant = async (resourceId: string, resourceType: Kept2ResourceType) => {
      const grant = await this.resourceKeys.deviceGrantFor(vaultId, resourceId, resourceType, device.deviceId, device.publicKey);
      mutations.push({
        operationId: `${lww.operationId}:${grant.grantId}`.slice(0, 180),
        mutationType: 'keyGrant.upsert',
        resourceId: grant.grantId,
        payload: { grant },
        lww,
        createdAt,
        attempts: 0
      });
    };

    for (const note of await this.localVault.notes()) {
      if (note.syncId) await addGrant(note.syncId, 'note.content');
    }
    for (const reminder of await this.localVault.reminders()) {
      if (reminder.syncId) await addGrant(reminder.syncId, 'reminder');
    }
    for (const label of await this.localVault.labels()) {
      if (label.syncId) await addGrant(label.syncId, 'label');
    }
    for (const binder of await this.localVault.binders()) {
      if (binder.syncId) await addGrant(binder.syncId, 'binder');
    }
    for (const attachment of await this.localVault.attachments()) {
      if (!attachment.syncId) continue;
      await addGrant(attachment.syncId, 'attachment');
      await addGrant(attachment.syncId, 'blob');
    }

    if (!mutations.length) return { granted: 0, failed: 0 };
    const results = await transport.mutate(vaultId, mutations);
    return {
      granted: results.filter(result => result.ok).length,
      failed: results.filter(result => !result.ok).length
    };
  }

  async importDeviceGrant(grant: KeyGrant) {
    const pair = await this.ensureLocalDeviceKeyPair();
    return this.resourceKeys.importDeviceGrant(grant, pair);
  }

  private async readStoredPair(deviceId: string): Promise<StoredDeviceKeyPair | null> {
    const secret = await this.platformSecret.get(this.secretKey(deviceId));
    if (secret) return JSON.parse(secret) as StoredDeviceKeyPair;
    const row = await this.driver.get<{ value: string }>(
      'SELECT value FROM key_metadata WHERE keyId = ?',
      [this.metadataKey(deviceId)]
    );
    return row ? JSON.parse(row.value) as StoredDeviceKeyPair : null;
  }

  private async writeStoredPair(pair: StoredDeviceKeyPair) {
    const now = new Date().toISOString();
    const serialized = JSON.stringify(pair);
    if (await this.platformSecret.isAvailable()) {
      await this.platformSecret.put(this.secretKey(pair.deviceId), serialized);
    }
    await this.driver.run(
      `INSERT INTO key_metadata (keyId, value, createdAt, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(keyId) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      [this.metadataKey(pair.deviceId), serialized, pair.createdAt || now, now]
    );
  }

  private async privateKeyFor(pair: StoredDeviceKeyPair) {
    const cached = this.cachedPrivateKeys.get(pair.deviceId);
    if (cached) return cached;
    const bytes = await this.crypto.unwrapKeyWithSymmetricKey(pair.wrappedPrivateKey, this.session.currentVmk());
    const privateKey = new TextDecoder().decode(bytes);
    this.cachedPrivateKeys.set(pair.deviceId, privateKey);
    return privateKey;
  }

  private async wrapPrivateKey(privateKey: string) {
    return this.crypto.wrapKeyWithSymmetricKey(new TextEncoder().encode(privateKey), this.session.currentVmk());
  }

  private metadataKey(deviceId: string) {
    return `deviceKeyPair:${deviceId}`;
  }

  private secretKey(deviceId: string) {
    return `kept2.deviceKeyPair.${deviceId}`;
  }
}
