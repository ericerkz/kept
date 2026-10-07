import { Injectable } from '@angular/core';
import { KEPT2_PROTOCOL_VERSION, VaultIdentity } from './vault-types';

const IDENTITY_KEY = 'kept2_vault_identity';

@Injectable({ providedIn: 'root' })
export class VaultIdentityService {
  async loadOrCreate(): Promise<VaultIdentity> {
    const existing = this.read();
    if (existing) return existing;
    const now = new Date().toISOString();
    const identity: VaultIdentity = {
      vaultId: `vault-${crypto.randomUUID()}`,
      deviceId: `device-${crypto.randomUUID()}`,
      protocolVersion: KEPT2_PROTOCOL_VERSION,
      createdAt: now,
      lastUnlockedAt: null
    };
    this.write(identity);
    return identity;
  }

  async markUnlocked() {
    const identity = await this.loadOrCreate();
    const next = { ...identity, lastUnlockedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  private read(): VaultIdentity | null {
    try {
      const raw = localStorage.getItem(IDENTITY_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as VaultIdentity;
      if (!parsed.vaultId || !parsed.deviceId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private write(identity: VaultIdentity) {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  }
}

