import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface NativeVaultSecretPlugin {
  getCapabilities(): Promise<{ platformKeyStore?: boolean }>;
  putSecret(input: { key: string; value: string }): Promise<void>;
  getSecret(input: { key: string }): Promise<{ value: string | null }>;
  deleteSecret(input: { key: string }): Promise<void>;
}

const Kept2VaultSecrets = registerPlugin<NativeVaultSecretPlugin>('Kept2Vault');

@Injectable({ providedIn: 'root' })
export class VaultPlatformSecretService {
  private available?: Promise<boolean>;

  async isAvailable() {
    this.available ||= this.detect();
    return this.available;
  }

  async put(key: string, value: string) {
    if (!await this.isAvailable()) throw new Error('Platform key store is not available.');
    await Kept2VaultSecrets.putSecret({ key, value });
  }

  async get(key: string) {
    if (!await this.isAvailable()) return null;
    const result = await Kept2VaultSecrets.getSecret({ key });
    return result.value || null;
  }

  async delete(key: string) {
    if (!await this.isAvailable()) return;
    await Kept2VaultSecrets.deleteSecret({ key });
  }

  private async detect() {
    if (!Capacitor.isNativePlatform()) return false;
    try {
      const capabilities = await Kept2VaultSecrets.getCapabilities();
      return !!capabilities.platformKeyStore;
    } catch {
      return false;
    }
  }
}
