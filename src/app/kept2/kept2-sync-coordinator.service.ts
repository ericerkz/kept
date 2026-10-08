import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { environment } from 'src/environments/environment';
import { SyncEngineService } from './sync-engine.service';
import { EncryptedSelfHostedTransport } from './sync-transport';
import { Kept2OutboxEntry, Kept2ResourceType, KeyGrant, SyncTransport, VaultIdentity } from './vault-types';
import { LocalFirstVaultService } from './local-first-vault.service';
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
    private localVault: LocalFirstVaultService,
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
      const hostedCalendar = await this.hostedCalendarKey(transport);
      await this.syncEngine.pushOutbox(
        activeIdentity.vaultId,
        transport,
        (resourceId, resourceType) => this.resourceKeys.keyFor(resourceId, resourceType),
        (vaultId, resourceId, resourceType) => this.grantsForResource(remoteMcp, hostedCalendar, vaultId, resourceId, resourceType)
      );
      if (remoteMcp) await this.reconcileRemoteMcpGrants(activeIdentity, transport, remoteMcp);
      if (hostedCalendar) await this.reconcileHostedCalendarGrants(activeIdentity, transport, hostedCalendar);
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
    hostedCalendar: { granteeId: string; publicKey: string } | null,
    vaultId: string,
    resourceId: string,
    resourceType: Kept2ResourceType
  ): Promise<KeyGrant[]> {
    const grants = [await this.resourceKeys.grantFor(vaultId, resourceId, resourceType)];
    if (remoteMcp) {
      if (resourceType === 'note.content') {
        const note = await this.localVault.getNote(resourceId);
        if (!note || this.isLockedNote(note)) return grants;
      }
      grants.push(await this.resourceKeys.publicKeyGrantFor(
        vaultId,
        resourceId,
        resourceType,
        'mcp',
        remoteMcp.granteeId,
        remoteMcp.publicKey
      ));
    }
    if (hostedCalendar) {
      if (resourceType === 'reminder' || (resourceType === 'note.content' && await this.noteHasReminder(resourceId))) {
        if (resourceType === 'note.content') {
          const note = await this.localVault.getNote(resourceId);
          if (!note || this.isLockedNote(note)) return grants;
        }
        grants.push(await this.resourceKeys.publicKeyGrantFor(
          vaultId,
          resourceId,
          resourceType,
          'calendar',
          hostedCalendar.granteeId,
          hostedCalendar.publicKey
        ));
      }
    }
    return grants;
  }

  private async reconcileRemoteMcpGrants(
    identity: VaultIdentity,
    transport: SyncTransport,
    remoteMcp: { granteeId: string; publicKey: string }
  ) {
    const mutations: Kept2OutboxEntry[] = [];
    const createdAt = new Date().toISOString();
    let logical = 0;
    const addGrantMutation = async (
      resourceId: string,
      resourceType: Kept2ResourceType,
      locked = false
    ) => {
      const grantId = this.resourceKeys.publicKeyGrantIdFor(
        identity.vaultId,
        resourceId,
        resourceType,
        'mcp',
        remoteMcp.granteeId
      );
      const stateKey = `${remoteMcp.publicKey}:${grantId}`;
      if (this.mcpGrantStates.get(stateKey) === (locked ? 'revoked' : 'granted')) return;
      const lww = {
        physicalMs: Date.now(),
        logical: logical++,
        deviceId: identity.deviceId,
        operationId: `${locked ? 'revoke' : 'grant'}-mcp-${crypto.randomUUID()}`
      };
      if (locked) {
        mutations.push({
          operationId: lww.operationId,
          mutationType: 'keyGrant.revoke',
          resourceId: grantId,
          payload: { grantId, resourceType: 'keyGrant' },
          lww,
          createdAt,
          attempts: 0
        });
      } else {
        const grant = await this.resourceKeys.publicKeyGrantFor(
          identity.vaultId,
          resourceId,
          resourceType,
          'mcp',
          remoteMcp.granteeId,
          remoteMcp.publicKey
        );
        mutations.push({
          operationId: lww.operationId,
          mutationType: 'keyGrant.upsert',
          resourceId: grant.grantId,
          payload: { grant },
          lww,
          createdAt,
          attempts: 0
        });
      }
    };

    for (const note of await this.localVault.notes()) {
      if (!note.syncId) continue;
      await addGrantMutation(note.syncId, 'note.content', this.isLockedNote(note));
    }
    for (const reminder of await this.localVault.reminders()) {
      if (!reminder.syncId) continue;
      await addGrantMutation(reminder.syncId, 'reminder');
    }
    for (const label of await this.localVault.labels()) {
      if (!label.syncId) continue;
      await addGrantMutation(label.syncId, 'label');
    }
    for (const binder of await this.localVault.binders()) {
      if (!binder.syncId) continue;
      await addGrantMutation(binder.syncId, 'binder');
    }
    for (const attachment of await this.localVault.attachments()) {
      if (!attachment.syncId) continue;
      await addGrantMutation(attachment.syncId, 'attachment');
      await addGrantMutation(attachment.syncId, 'blob');
    }
    for (let index = 0; index < mutations.length; index += 100) {
      const chunk = mutations.slice(index, index + 100);
      const results = await transport.mutate(identity.vaultId, chunk);
      results.forEach((result, offset) => {
        if (!result.ok) return;
        const mutation = chunk[offset];
        const state = mutation.mutationType === 'keyGrant.revoke' ? 'revoked' : 'granted';
        this.mcpGrantStates.set(`${remoteMcp.publicKey}:${mutation.resourceId}`, state);
      });
    }
  }

  private async reconcileHostedCalendarGrants(
    identity: VaultIdentity,
    transport: SyncTransport,
    hostedCalendar: { granteeId: string; publicKey: string }
  ) {
    const mutations: Kept2OutboxEntry[] = [];
    const createdAt = new Date().toISOString();
    let logical = 0;
    const addGrantMutation = async (
      resourceId: string,
      resourceType: Extract<Kept2ResourceType, 'note.content' | 'reminder'>,
      revoke = false
    ) => {
      const grantId = this.resourceKeys.publicKeyGrantIdFor(
        identity.vaultId,
        resourceId,
        resourceType,
        'calendar',
        hostedCalendar.granteeId
      );
      const stateKey = `${hostedCalendar.publicKey}:${grantId}`;
      if (this.calendarGrantStates.get(stateKey) === (revoke ? 'revoked' : 'granted')) return;
      const lww = {
        physicalMs: Date.now(),
        logical: logical++,
        deviceId: identity.deviceId,
        operationId: `${revoke ? 'revoke' : 'grant'}-calendar-${crypto.randomUUID()}`
      };
      if (revoke) {
        mutations.push({
          operationId: lww.operationId,
          mutationType: 'keyGrant.revoke',
          resourceId: grantId,
          payload: { grantId, resourceType: 'keyGrant' },
          lww,
          createdAt,
          attempts: 0
        });
      } else {
        const grant = await this.resourceKeys.publicKeyGrantFor(
          identity.vaultId,
          resourceId,
          resourceType,
          'calendar',
          hostedCalendar.granteeId,
          hostedCalendar.publicKey
        );
        mutations.push({
          operationId: lww.operationId,
          mutationType: 'keyGrant.upsert',
          resourceId: grant.grantId,
          payload: { grant },
          lww,
          createdAt,
          attempts: 0
        });
      }
    };

    const reminders = await this.localVault.reminders();
    const noteIdsWithReminders = new Set(reminders.map(reminder => String((reminder as { noteSyncId?: string }).noteSyncId || '')).filter(Boolean));
    for (const reminder of reminders) {
      if (reminder.syncId) await addGrantMutation(reminder.syncId, 'reminder');
    }
    for (const note of await this.localVault.notes()) {
      if (!note.syncId) continue;
      await addGrantMutation(note.syncId, 'note.content', this.isLockedNote(note) || !noteIdsWithReminders.has(note.syncId));
    }
    for (let index = 0; index < mutations.length; index += 100) {
      const chunk = mutations.slice(index, index + 100);
      const results = await transport.mutate(identity.vaultId, chunk);
      results.forEach((result, offset) => {
        if (!result.ok) return;
        const mutation = chunk[offset];
        const state = mutation.mutationType === 'keyGrant.revoke' ? 'revoked' : 'granted';
        this.calendarGrantStates.set(`${hostedCalendar.publicKey}:${mutation.resourceId}`, state);
      });
    }
  }

  private remoteMcpKey(transport: SyncTransport) {
    if (!transport.integrationServiceKey) return Promise.resolve(null);
    return transport.integrationServiceKey('remote-mcp');
  }

  private hostedCalendarKey(transport: SyncTransport) {
    if (!transport.integrationServiceKey) return Promise.resolve(null);
    return transport.integrationServiceKey('hosted-calendar');
  }

  private async noteHasReminder(noteSyncId: string) {
    return (await this.localVault.reminders()).some(reminder => (reminder as { noteSyncId?: string }).noteSyncId === noteSyncId);
  }

  private mcpGrantStates = new Map<string, 'granted' | 'revoked'>();
  private calendarGrantStates = new Map<string, 'granted' | 'revoked'>();

  private isLockedNote(note: { locked?: boolean; lockSalt?: string; lockHash?: string }) {
    return !!(note.locked && note.lockSalt && note.lockHash);
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
