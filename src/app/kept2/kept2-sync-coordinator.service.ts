import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { environment } from 'src/environments/environment';
import { SyncEngineService } from './sync-engine.service';
import { EncryptedSelfHostedTransport } from './sync-transport';
import { VaultIdentity } from './vault-types';
import { VaultResourceKeyService } from './vault-resource-key.service';
import { VaultSessionService } from './vault-session.service';

@Injectable({ providedIn: 'root' })
export class Kept2SyncCoordinatorService {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private lastError = '';
  private lastSyncAt = '';

  constructor(
    private auth: AuthService,
    private http: HttpClient,
    private resourceKeys: VaultResourceKeyService,
    private session: VaultSessionService,
    private syncEngine: SyncEngineService
  ) {}

  start(identity: VaultIdentity) {
    this.stop();
    this.syncOnce(identity);
    this.timer = setInterval(() => this.syncOnce(identity), 15000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
  }

  status() {
    return {
      running: this.running,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt
    };
  }

  async syncOnce(identity?: VaultIdentity) {
    const activeIdentity = identity || this.session.currentSession()?.identity;
    if (!activeIdentity || !this.session.isUnlocked() || !this.auth.currentUser || this.running) return;
    this.running = true;
    this.lastError = '';
    try {
      const transport = new EncryptedSelfHostedTransport(
        this.http,
        environment.apiUrl,
        () => this.auth.authHeaders()
      );
      await this.syncEngine.pushOutbox(
        activeIdentity.vaultId,
        transport,
        (resourceId, resourceType) => this.resourceKeys.keyFor(resourceId, resourceType)
      );
      await this.syncEngine.pullChanges(
        activeIdentity.vaultId,
        transport,
        (resourceId, resourceType) => this.resourceKeys.existingKeyFor(resourceId, resourceType)
      );
      this.lastSyncAt = new Date().toISOString();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Kept 2 sync failed.';
    } finally {
      this.running = false;
    }
  }
}
