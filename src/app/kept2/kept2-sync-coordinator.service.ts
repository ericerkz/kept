import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { environment } from 'src/environments/environment';
import { SyncEngineService } from './sync-engine.service';
import { EncryptedSelfHostedTransport } from './sync-transport';
import { Kept2ResourceType, KeyGrant, SyncTransport, VaultIdentity } from './vault-types';
import { VaultResourceKeyService } from './vault-resource-key.service';
import { VaultSessionService } from './vault-session.service';
import { VaultDevicePairingService } from './vault-device-pairing.service';

@Injectable({ providedIn: 'root' })
export class Kept2SyncCoordinatorService {
  private timer?: ReturnType<typeof setInterval>;
  private syncSoonTimer?: ReturnType<typeof setTimeout>;
  private unsubscribeRealtime?: () => void;
  private running = false;
  private lastError = '';
  private lastSyncAt = '';
  private started = false;

  constructor(
    private auth: AuthService,
    private http: HttpClient,
    private devicePairing: VaultDevicePairingService,
    private resourceKeys: VaultResourceKeyService,
    private session: VaultSessionService,
    private syncEngine: SyncEngineService
  ) {
    this.registerGlobalTriggers();
  }

  start(identity: VaultIdentity) {
    this.stopRealtime();
    this.started = true;
    this.syncOnce(identity);
    this.unsubscribeRealtime = this.transport().subscribeRealtime(identity.vaultId, () => this.syncOnce(identity));
    this.timer = setInterval(() => this.syncOnce(identity), 15000);
  }

  stop() {
    this.started = false;
    this.stopRealtime();
    this.running = false;
  }

  status() {
    return {
      running: this.running,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt
    };
  }

  private stopRealtime() {
    if (this.timer) clearInterval(this.timer);
    if (this.syncSoonTimer) clearTimeout(this.syncSoonTimer);
    if (this.unsubscribeRealtime) this.unsubscribeRealtime();
    this.timer = undefined;
    this.syncSoonTimer = undefined;
    this.unsubscribeRealtime = undefined;
  }

  async syncOnce(identity?: VaultIdentity) {
    const activeIdentity = identity || this.session.currentSession()?.identity;
    if (!activeIdentity || !this.session.isUnlocked() || !this.auth.currentUser || this.running) return;
    this.running = true;
    this.lastError = '';
    try {
      const transport = this.transport();
      const remoteMcp = await this.remoteMcpKey(transport);
      await this.syncEngine.pushOutbox(
        activeIdentity.vaultId,
        transport,
        (resourceId, resourceType) => this.resourceKeys.keyFor(resourceId, resourceType),
        (vaultId, resourceId, resourceType) => this.grantsForResource(remoteMcp, vaultId, resourceId, resourceType)
      );
      await this.syncEngine.pullChanges(
        activeIdentity.vaultId,
        transport,
        (resourceId, resourceType) => this.resourceKeys.existingKeyFor(resourceId, resourceType),
        grant => this.resourceKeys.importGrant(grant).then(imported => imported || this.devicePairing.importDeviceGrant(grant))
      );
      this.lastSyncAt = new Date().toISOString();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Kept 2 sync failed.';
    } finally {
      this.running = false;
    }
  }

  private transport() {
    return new EncryptedSelfHostedTransport(
      this.http,
      environment.apiUrl,
      () => this.auth.authHeaders()
    );
  }

  private async grantsForResource(
    remoteMcp: { granteeId: string; publicKey: string } | null,
    vaultId: string,
    resourceId: string,
    resourceType: Kept2ResourceType
  ): Promise<KeyGrant[]> {
    const grants = [await this.resourceKeys.grantFor(vaultId, resourceId, resourceType)];
    if (remoteMcp) {
      grants.push(await this.resourceKeys.publicKeyGrantFor(
        vaultId,
        resourceId,
        resourceType,
        'mcp',
        remoteMcp.granteeId,
        remoteMcp.publicKey
      ));
    }
    return grants;
  }

  private remoteMcpKey(transport: SyncTransport) {
    if (!transport.integrationServiceKey) return Promise.resolve(null);
    return transport.integrationServiceKey('remote-mcp');
  }

  private registerGlobalTriggers() {
    if (typeof window === 'undefined') return;
    const request = () => this.scheduleSync();
    window.addEventListener('online', request);
    window.addEventListener('focus', request);
    window.addEventListener('kept2-outbox-changed', request);
    window.addEventListener('kept2-local-first-changed', request);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') request();
      });
    }
  }

  private scheduleSync(delay = 300) {
    if (!this.started && !this.session.currentSession()) return;
    if (this.syncSoonTimer) clearTimeout(this.syncSoonTimer);
    this.syncSoonTimer = setTimeout(() => {
      this.syncSoonTimer = undefined;
      this.syncOnce().catch(console.error);
    }, delay);
  }
}
