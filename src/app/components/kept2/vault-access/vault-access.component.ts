import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { toDataURL } from 'qrcode';
import { NoteAttachmentI, NoteI } from 'src/app/interfaces/notes';
import { ReminderI } from 'src/app/interfaces/reminder';
import { LocalFirstVaultService } from 'src/app/kept2/local-first-vault.service';
import { Kept2SyncCoordinatorService } from 'src/app/kept2/kept2-sync-coordinator.service';
import { SyncEngineService } from 'src/app/kept2/sync-engine.service';
import { EncryptedSelfHostedTransport } from 'src/app/kept2/sync-transport';
import { VaultDevicePairingService } from 'src/app/kept2/vault-device-pairing.service';
import { VaultResourceKeyService } from 'src/app/kept2/vault-resource-key.service';
import { VaultSessionService } from 'src/app/kept2/vault-session.service';
import { HostedIntegrationSetting, KeyGrant, VaultDevicePublicKey, VaultIdentity } from 'src/app/kept2/vault-types';
import { AuthService } from 'src/app/services/auth.service';
import { environment } from 'src/environments/environment';

type VaultMode = 'create' | 'unlock' | 'recover';

interface MigrationResource {
  resourceId: string;
  resourceType: string;
  lww?: {
    physicalMs: number;
    logical: number;
    deviceId: string;
    operationId: string;
  };
  plaintext: any;
}

interface MigrationExport {
  vaultId: string;
  snapshotId: string;
  snapshotHash: string;
  counts: Record<string, number>;
  resources: MigrationResource[];
  warnings: Array<{ code: string; legacyId?: number; syncId?: string }>;
  limitations?: string[];
}

interface MigrationCutoverReceipt {
  cutoverReady: boolean;
  vaultId: string;
  snapshotId: string;
  snapshotHash: string;
  resourceCount: number;
  completedAt: string;
}

declare const BarcodeDetector: {
  new(options: { formats: string[] }): {
    detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
  };
} | undefined;

@Component({
  selector: 'app-kept2-vault-access',
  templateUrl: './vault-access.component.html',
  styleUrls: ['../../auth/auth-shared.scss', './vault-access.component.scss'],
  standalone: false
})
export class VaultAccessComponent implements OnInit, OnDestroy {
  mode: VaultMode = 'unlock';
  password = '';
  confirmPassword = '';
  recoveryCode = '';
  recoveryPassword = '';
  error = '';
  success = '';
  generatedRecoveryCode = '';
  isBusy = false;
  hasVault = false;
  identity: VaultIdentity | null = null;
  notes: NoteI[] = [];
  outboxCount = 0;
  draftTitle = '';
  draftBody = '';
  selectedSyncId = '';
  syncStatus = '';
  migrationStatus = '';
  migrationWarnings: string[] = [];
  localSearchQuery = '';
  deviceLabel = '';
  devicePairingStatus = '';
  pairingCode = '';
  pairingQrCodeUrl = '';
  incomingPairingCode = '';
  remoteDevices: VaultDevicePublicKey[] = [];
  hostedIntegrations: Record<'remote-mcp' | 'hosted-calendar', HostedIntegrationSetting | null> = {
    'remote-mcp': null,
    'hosted-calendar': null
  };
  hostedIntegrationStatus = '';

  constructor(
    public auth: AuthService,
    private http: HttpClient,
    private vaultSession: VaultSessionService,
    private localVault: LocalFirstVaultService,
    private devicePairing: VaultDevicePairingService,
    private resourceKeys: VaultResourceKeyService,
    private syncCoordinator: Kept2SyncCoordinatorService,
    private syncEngine: SyncEngineService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  async ngOnInit() {
    this.hasVault = await this.vaultSession.hasLocalVault();
    this.identity = this.vaultSession.currentSession()?.identity || null;
    this.mode = this.hasVault ? 'unlock' : 'create';
    if (this.identity) {
      this.syncCoordinator.start(this.identity);
      await this.refreshLocalState();
      await this.refreshRemoteDevices(false);
      await this.refreshHostedIntegrations(false);
    }
  }

  ngOnDestroy() {
    // Sync is app-wide once the vault is unlocked; lock/delete explicitly stop it.
  }

  setMode(mode: VaultMode) {
    this.mode = mode;
    this.error = '';
    this.success = '';
  }

  async createVault() {
    this.error = '';
    this.success = '';
    if (this.password !== this.confirmPassword) {
      this.error = 'Passwords do not match.';
      return;
    }
    this.isBusy = true;
    try {
      const result = await this.vaultSession.createLocalVault(this.password);
      this.identity = result.identity;
      this.generatedRecoveryCode = result.recoveryCode;
      this.hasVault = true;
      this.password = '';
      this.confirmPassword = '';
      this.success = 'Vault created and unlocked.';
      this.syncCoordinator.start(result.identity);
      await this.refreshLocalState();
      await this.registerThisDevice(false);
      await this.refreshHostedIntegrations(false);
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not create vault.';
    } finally {
      this.isBusy = false;
    }
  }

  async unlockVault() {
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      const session = await this.vaultSession.unlockWithPassword(this.password);
      this.identity = session.identity;
      this.password = '';
      this.success = 'Vault unlocked.';
      this.syncCoordinator.start(session.identity);
      await this.refreshLocalState();
      await this.refreshRemoteDevices(false);
      await this.refreshHostedIntegrations(false);
      await this.navigateToReturnUrl();
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not unlock vault.';
    } finally {
      this.isBusy = false;
    }
  }

  async recoverVault() {
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      const session = await this.vaultSession.recoverWithCode(this.recoveryCode, this.recoveryPassword || undefined);
      this.identity = session?.identity || null;
      this.recoveryCode = '';
      this.recoveryPassword = '';
      this.success = 'Vault recovered and unlocked.';
      if (this.identity) this.syncCoordinator.start(this.identity);
      await this.refreshLocalState();
      await this.refreshRemoteDevices(false);
      await this.refreshHostedIntegrations(false);
      await this.navigateToReturnUrl();
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not recover vault.';
    } finally {
      this.isBusy = false;
    }
  }

  lockVault() {
    this.vaultSession.lock();
    this.syncCoordinator.stop();
    this.resourceKeys.clearCache();
    this.identity = null;
    this.notes = [];
    this.remoteDevices = [];
    this.hostedIntegrations = { 'remote-mcp': null, 'hosted-calendar': null };
    this.hostedIntegrationStatus = '';
    this.outboxCount = 0;
    this.clearDraft();
    this.success = 'Vault locked.';
  }

  async deleteLocalVault() {
    const confirmed = window.confirm(
      'Delete this local Kept 2 vault from this device? Synced encrypted server data is not deleted.'
    );
    if (!confirmed) return;
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      this.syncCoordinator.stop();
      this.resourceKeys.clearCache();
      await this.vaultSession.deleteLocalVault();
      this.identity = null;
      this.notes = [];
      this.remoteDevices = [];
      this.hostedIntegrations = { 'remote-mcp': null, 'hosted-calendar': null };
      this.hostedIntegrationStatus = '';
      this.outboxCount = 0;
      this.hasVault = false;
      this.generatedRecoveryCode = '';
      this.mode = 'create';
      this.clearDraft();
      this.success = 'Local vault deleted from this device.';
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not delete the local vault.';
    } finally {
      this.isBusy = false;
    }
  }

  async pushOutbox() {
    if (!this.identity) return;
    this.error = '';
    this.success = '';
    this.syncStatus = '';
    if (!this.auth.currentUser) {
      this.error = 'Sign in to the Kept server before syncing this local vault.';
      return;
    }
    this.isBusy = true;
    try {
      const result = await this.syncEngine.pushOutbox(
        this.identity.vaultId,
        this.transport(),
        (resourceId, resourceType) => this.resourceKeys.keyFor(resourceId, resourceType),
        (vaultId, resourceId, resourceType) => this.resourceKeys.grantFor(vaultId, resourceId, resourceType)
      );
      this.syncStatus = `Pushed ${result.removed} of ${result.pushed} pending operation${result.pushed === 1 ? '' : 's'}.`;
      await this.refreshLocalState();
      await this.refreshRemoteDevices(false);
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not push local changes.';
    } finally {
      this.isBusy = false;
    }
  }

  async pullRemote() {
    if (!this.identity) return;
    this.error = '';
    this.success = '';
    this.syncStatus = '';
    if (!this.auth.currentUser) {
      this.error = 'Sign in to the Kept server before syncing this local vault.';
      return;
    }
    this.isBusy = true;
    try {
      const result = await this.syncEngine.pullChanges(
        this.identity.vaultId,
        this.transport(),
        (resourceId, resourceType) => this.resourceKeys.existingKeyFor(resourceId, resourceType),
        grant => this.importRemoteGrant(grant)
      );
      this.syncStatus = `Pulled ${result.applied} remote change${result.applied === 1 ? '' : 's'}${result.failed ? `; ${result.failed} could not be decrypted on this device yet` : ''}.`;
      await this.refreshLocalState();
      await this.refreshRemoteDevices(false);
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not pull remote changes.';
    } finally {
      this.isBusy = false;
    }
  }

  async bootstrapRemote() {
    if (!this.identity) return;
    this.error = '';
    this.success = '';
    this.syncStatus = '';
    if (!this.auth.currentUser) {
      this.error = 'Sign in to the Kept server before syncing this local vault.';
      return;
    }
    this.isBusy = true;
    try {
      const result = await this.syncEngine.bootstrapRemote(
        this.identity.vaultId,
        this.transport(),
        (resourceId, resourceType) => this.resourceKeys.existingKeyFor(resourceId, resourceType),
        grant => this.importRemoteGrant(grant)
      );
      this.syncStatus = `Bootstrapped ${result.applied} encrypted resource${result.applied === 1 ? '' : 's'}${result.failed ? `; ${result.failed} could not be decrypted on this device yet` : ''}.`;
      await this.refreshLocalState();
      await this.refreshRemoteDevices(false);
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not bootstrap remote vault.';
    } finally {
      this.isBusy = false;
    }
  }

  async importLegacySnapshot() {
    if (!this.identity) return;
    this.error = '';
    this.success = '';
    this.migrationStatus = '';
    this.migrationWarnings = [];
    if (!this.auth.currentUser) {
      this.error = 'Sign in to the Kept server before importing legacy notes.';
      return;
    }
    this.isBusy = true;
    try {
      const migration = await firstValueFrom(this.http.get<MigrationExport>(`${environment.apiUrl}/v2/migration/export`, {
        headers: this.auth.authHeaders(),
        params: { vaultId: this.identity.vaultId }
      }));
      const imported = await this.importMigrationResources(migration.resources || []);
      await this.syncEngine.pushOutbox(
        this.identity.vaultId,
        this.transport(),
        (resourceId, resourceType) => this.resourceKeys.keyFor(resourceId, resourceType),
        (vaultId, resourceId, resourceType) => this.resourceKeys.grantFor(vaultId, resourceId, resourceType)
      );
      const cutover = await this.acknowledgeMigrationCutover(migration, migration.resources?.length || 0);
      this.migrationWarnings = [
        ...(migration.warnings || []).map(warning => warning.code),
        ...(migration.limitations || [])
      ];
      this.migrationStatus = `Imported ${imported.notes} note${imported.notes === 1 ? '' : 's'}, ${imported.labels} label${imported.labels === 1 ? '' : 's'}, ${imported.binders} binder${imported.binders === 1 ? '' : 's'}, ${imported.reminders} reminder${imported.reminders === 1 ? '' : 's'}, ${imported.attachments} attachment record${imported.attachments === 1 ? '' : 's'}, and ${imported.attachmentBlobs} attachment file${imported.attachmentBlobs === 1 ? '' : 's'} into the local vault. Cutover receipt saved for ${cutover.resourceCount} encrypted resource${cutover.resourceCount === 1 ? '' : 's'}.`;
      await this.refreshLocalState();
      await this.refreshRemoteDevices(false);
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not import legacy notes.';
    } finally {
      this.isBusy = false;
    }
  }

  async exportLocalVault() {
    if (!this.identity) return;
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      const notes = await this.localVault.notes();
      const reminders = await this.localVault.reminders();
      const labels = await this.localVault.labels();
      const binders = await this.localVault.binders();
      const attachments = await this.localVault.attachments();
      const attachmentBlobs: Record<string, { dataUrl: string; mimeType: string; size: number }> = {};

      for (const attachment of attachments) {
        if (!attachment.syncId) continue;
        const blob = await this.localVault.attachmentBlob(attachment.syncId);
        if (!blob) continue;
        attachmentBlobs[attachment.syncId] = {
          dataUrl: await this.blobToDataUrl(blob),
          mimeType: blob.type || attachment.mimeType || 'application/octet-stream',
          size: blob.size
        };
      }

      this.downloadJson(`kept2-vault-${this.identity.vaultId}-${Date.now()}.json`, {
        format: 'kept2-local-export',
        exportedAt: new Date().toISOString(),
        vault: this.identity,
        counts: {
          notes: notes.length,
          reminders: reminders.length,
          labels: labels.length,
          binders: binders.length,
          attachments: attachments.length,
          attachmentBlobs: Object.keys(attachmentBlobs).length
        },
        notes,
        reminders,
        labels,
        binders,
        attachments,
        attachmentBlobs
      });
      this.success = 'Local vault export created.';
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not export the local vault.';
    } finally {
      this.isBusy = false;
    }
  }

  async registerThisDevice(showStatus = true) {
    if (!this.identity || !this.auth.currentUser) return;
    this.error = '';
    if (showStatus) this.devicePairingStatus = '';
    this.isBusy = true;
    try {
      const label = this.deviceLabel.trim() || this.defaultDeviceLabel();
      const device = await this.devicePairing.registerThisDevice(this.transport(), label);
      if (showStatus) this.devicePairingStatus = `Registered ${device.deviceLabel || device.deviceId}.`;
      await this.refreshRemoteDevices(false);
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not register this device.';
    } finally {
      this.isBusy = false;
    }
  }

  async createPairingCode() {
    if (!this.identity) return;
    this.error = '';
    this.devicePairingStatus = '';
    this.isBusy = true;
    try {
      this.pairingCode = await this.devicePairing.createPairingCode(this.deviceLabel.trim() || this.defaultDeviceLabel());
      this.pairingQrCodeUrl = await toDataURL(this.pairingCode, {
        color: { dark: '#202124', light: '#ffffff' },
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 220
      });
      await navigator.clipboard?.writeText(this.pairingCode).catch(() => undefined);
      this.devicePairingStatus = 'Pairing code created. Share it with an already-unlocked device for approval.';
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not create a pairing code.';
    } finally {
      this.isBusy = false;
    }
  }

  async approvePairingCode() {
    if (!this.identity || !this.auth.currentUser) return;
    this.error = '';
    this.devicePairingStatus = '';
    this.isBusy = true;
    try {
      const result = await this.devicePairing.approvePairingCode(this.transport(), this.incomingPairingCode);
      this.incomingPairingCode = '';
      this.devicePairingStatus = `Approved ${result.device.deviceLabel || result.device.deviceId} and granted ${result.granted} key${result.granted === 1 ? '' : 's'}${result.failed ? `; ${result.failed} failed` : ''}.`;
      await this.refreshRemoteDevices(false);
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not approve that pairing code.';
    } finally {
      this.isBusy = false;
    }
  }

  async scanPairingQr(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error = '';
    this.devicePairingStatus = '';
    try {
      if (typeof BarcodeDetector === 'undefined' || typeof createImageBitmap !== 'function') {
        this.devicePairingStatus = 'QR scanning is not available in this browser. Paste the pairing code instead.';
        return;
      }
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const bitmap = await createImageBitmap(file);
      try {
        const codes = await detector.detect(bitmap);
        const value = codes.find(code => !!code.rawValue)?.rawValue || '';
        if (!value) throw new Error('No QR code was found in that image.');
        this.incomingPairingCode = value;
        this.devicePairingStatus = 'Pairing code scanned. Review and approve it when ready.';
      } finally {
        bitmap.close?.();
      }
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not scan that QR code.';
    }
  }

  async refreshRemoteDevices(showStatus = true) {
    if (!this.identity || !this.auth.currentUser) return;
    try {
      this.remoteDevices = await this.devicePairing.listRemoteDevices(this.transport());
      if (showStatus) this.devicePairingStatus = `Found ${this.remoteDevices.length} registered device${this.remoteDevices.length === 1 ? '' : 's'}.`;
    } catch (error: any) {
      if (showStatus) this.error = error instanceof Error ? error.message : 'Could not load registered devices.';
    }
  }

  async grantLocalResourcesToDevice(device: VaultDevicePublicKey) {
    if (!this.identity) return;
    this.error = '';
    this.devicePairingStatus = '';
    this.isBusy = true;
    try {
      const result = await this.devicePairing.grantLocalResourcesToDevice(this.transport(), device);
      this.devicePairingStatus = `Granted ${result.granted} key${result.granted === 1 ? '' : 's'} to ${device.deviceLabel || device.deviceId}${result.failed ? `; ${result.failed} failed` : ''}.`;
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not grant keys to that device.';
    } finally {
      this.isBusy = false;
    }
  }

  async revokeDevice(device: VaultDevicePublicKey) {
    if (!this.identity) return;
    const label = device.deviceLabel || device.deviceId;
    if (!window.confirm(`Revoke ${label}? This stops future sync/grant access for that device, but does not rotate existing resource keys.`)) return;
    this.error = '';
    this.devicePairingStatus = '';
    this.isBusy = true;
    try {
      await this.transport().revokeDevice?.(this.identity.vaultId, device.deviceId);
      this.devicePairingStatus = `Revoked ${label}.`;
      await this.refreshRemoteDevices(false);
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not revoke that device.';
    } finally {
      this.isBusy = false;
    }
  }

  async refreshHostedIntegrations(showStatus = true) {
    if (!this.identity || !this.auth.currentUser) return;
    try {
      const transport = this.transport();
      const [remoteMcp, hostedCalendar] = await Promise.all([
        transport.integrationSetting?.('remote-mcp') || Promise.resolve(null),
        transport.integrationSetting?.('hosted-calendar') || Promise.resolve(null)
      ]);
      this.hostedIntegrations = {
        'remote-mcp': remoteMcp,
        'hosted-calendar': hostedCalendar
      };
      if (showStatus) this.hostedIntegrationStatus = 'Hosted integration settings refreshed.';
    } catch (error: any) {
      if (showStatus) this.error = error instanceof Error ? error.message : 'Could not load hosted integration settings.';
    }
  }

  async toggleHostedIntegration(integration: 'remote-mcp' | 'hosted-calendar', event: Event) {
    if (!this.identity || !this.auth.currentUser) return;
    const input = event.target as HTMLInputElement;
    const enabled = !!input.checked;
    if (!enabled) {
      const ok = window.confirm(
        `Disable ${this.hostedIntegrationLabel(integration)}? Future service access is revoked and pending jobs are cancelled, but existing resource keys are not rotated.`
      );
      if (!ok) {
        input.checked = true;
        return;
      }
    }
    this.error = '';
    this.hostedIntegrationStatus = '';
    this.isBusy = true;
    try {
      const setting = await this.transport().setIntegrationEnabled(integration, enabled);
      this.hostedIntegrations = {
        ...this.hostedIntegrations,
        [integration]: setting
      };
      if (enabled) {
        this.hostedIntegrationStatus = `${this.hostedIntegrationLabel(integration)} enabled. Eligible local resources will be granted on the next sync.`;
        await this.syncCoordinator.syncOnce(this.identity);
        await this.refreshLocalState();
      } else {
        const revoked = Number(setting.revokedGrants || 0);
        const cancelled = Number(setting.cancelledJobs || 0);
        this.hostedIntegrationStatus = `${this.hostedIntegrationLabel(integration)} disabled. Revoked ${revoked} grant${revoked === 1 ? '' : 's'} and cancelled ${cancelled} job${cancelled === 1 ? '' : 's'}.`;
      }
      await this.refreshHostedIntegrations(false);
    } catch (error: any) {
      input.checked = !enabled;
      this.error = error?.error?.error || (error instanceof Error ? error.message : 'Could not update hosted integration.');
    } finally {
      this.isBusy = false;
    }
  }

  hostedIntegrationLabel(integration: 'remote-mcp' | 'hosted-calendar') {
    return integration === 'remote-mcp' ? 'Hosted MCP' : 'Hosted calendar';
  }

  async saveDraft() {
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      if (this.selectedSyncId) {
        await this.localVault.updateNote(this.selectedSyncId, {
          noteTitle: this.draftTitle,
          noteBody: this.draftBody
        });
        this.success = 'Local note updated.';
      } else {
        await this.localVault.createNote({
          noteTitle: this.draftTitle,
          noteBody: this.draftBody
        });
        this.success = 'Local note created.';
      }
      this.clearDraft();
      await this.refreshLocalState();
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not save local note.';
    } finally {
      this.isBusy = false;
    }
  }

  editNote(note: NoteI) {
    this.selectedSyncId = note.syncId || '';
    this.draftTitle = note.noteTitle || '';
    this.draftBody = note.noteBody || '';
    this.error = '';
    this.success = '';
  }

  async deleteNote(note: NoteI) {
    if (!note.syncId) return;
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      await this.localVault.deleteNote(note.syncId);
      if (this.selectedSyncId === note.syncId) this.clearDraft();
      this.success = 'Local note deleted.';
      await this.refreshLocalState();
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not delete local note.';
    } finally {
      this.isBusy = false;
    }
  }

  clearDraft() {
    this.selectedSyncId = '';
    this.draftTitle = '';
    this.draftBody = '';
  }

  async searchLocalNotes() {
    this.error = '';
    try {
      this.notes = await this.localVault.searchNotes(this.localSearchQuery);
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not search local notes.';
    }
  }

  async clearLocalSearch() {
    this.localSearchQuery = '';
    await this.refreshLocalState();
  }

  private async navigateToReturnUrl() {
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
    if (!returnUrl || returnUrl.startsWith('/kept2')) return;
    await this.router.navigateByUrl(returnUrl.startsWith('/') ? returnUrl : `/${returnUrl}`);
  }

  private async refreshLocalState() {
    this.notes = this.localSearchQuery.trim()
      ? await this.localVault.searchNotes(this.localSearchQuery)
      : await this.localVault.notes();
    this.outboxCount = (await this.localVault.outbox()).length;
  }

  private async importMigrationResources(resources: MigrationResource[]) {
    const ownerState = new Map<string, any>();
    for (const resource of resources) {
      if (resource.resourceType === 'note.ownerState') {
        ownerState.set(resource.resourceId.replace(/:owner$/, ''), resource.plaintext || {});
      }
    }

    let notes = 0;
    let labels = 0;
    let binders = 0;
    let reminders = 0;
    let attachments = 0;
    let attachmentBlobs = 0;
    for (const resource of resources) {
      if (resource.resourceType === 'note.content') {
        const plain = resource.plaintext || {};
        const hydrated = await this.hydrateLegacyNoteImages(plain);
        const owner = ownerState.get(resource.resourceId) || {};
        await this.localVault.createNote({
          syncId: resource.resourceId,
          id: hydrated.legacyId,
          ownerUserId: owner.ownerUserId || undefined,
          noteTitle: hydrated.title || '',
          noteBody: hydrated.body || '',
          checkBoxes: hydrated.checkBoxes || [],
          images: hydrated.images || [],
          isCbox: !!hydrated.isChecklist,
          labels: hydrated.labels || [],
          binder: hydrated.binder || '',
          locked: !!hydrated.locked,
          lockSalt: hydrated.lockSalt || '',
          lockHash: hydrated.lockHash || '',
          pinned: !!owner.pinned,
          archived: !!owner.archived,
          trashed: !!owner.trashed,
          trashedAt: owner.trashedAt || undefined,
          sortOrder: owner.sortOrder,
          bgColor: owner.bgColor || '',
          bgImage: owner.bgImage || '',
          completedChecklistCollapsed: !!owner.completedChecklistCollapsed,
          createdAt: hydrated.createdAt,
          updatedAt: hydrated.updatedAt
        });
        notes += 1;
      } else if (resource.resourceType === 'reminder') {
        const plain = resource.plaintext || {};
        const reminder: ReminderI & { noteSyncId?: string } = {
          id: Number(plain.legacyId || 0),
          syncId: resource.resourceId,
          noteId: null,
          noteSyncId: plain.noteSyncId || '',
          userId: 0,
          dueAtUtc: plain.dueAt || null,
          timezone: plain.timezone || 'UTC',
          repeatRule: plain.repeatRule || null,
          status: plain.status || 'pending',
          title: plain.title || null,
          body: plain.body || null,
          imageUrl: plain.imageUrl || null,
          locationName: plain.locationName || null,
          latitude: plain.latitude ?? null,
          longitude: plain.longitude ?? null,
          radiusMeters: plain.radiusMeters ?? null,
          locationTrigger: plain.locationTrigger || 'arrive',
          createdAt: plain.createdAt || new Date().toISOString(),
          updatedAt: plain.updatedAt || new Date().toISOString()
        };
        await this.localVault.upsertReminder(reminder);
        reminders += 1;
      } else if (resource.resourceType === 'label') {
        const plain = resource.plaintext || {};
        await this.localVault.upsertLabel({
          syncId: resource.resourceId,
          id: Number(plain.legacyId || 0) || undefined,
          name: plain.name || ''
        });
        labels += 1;
      } else if (resource.resourceType === 'binder') {
        const plain = resource.plaintext || {};
        await this.localVault.upsertBinder({
          syncId: resource.resourceId,
          name: plain.name || '',
          createdAt: plain.createdAt,
          updatedAt: plain.updatedAt
        });
        binders += 1;
      } else if (resource.resourceType === 'attachment') {
        const plain = resource.plaintext || {};
        const attachment: NoteAttachmentI & { noteSyncId?: string } = {
          id: Number(plain.legacyId || 0),
          syncId: resource.resourceId,
          noteId: undefined,
          noteSyncId: plain.noteSyncId || '',
          originalName: plain.originalName || '',
          fileSize: Number(plain.fileSize || 0),
          mimeType: plain.mimeType || 'application/octet-stream',
          uploadedAt: plain.uploadedAt || new Date().toISOString()
        };
        const blob = await this.fetchLegacyAttachmentBlob(resource.resourceId);
        await this.localVault.upsertAttachment(attachment, blob);
        if (blob) attachmentBlobs += 1;
        attachments += 1;
      }
    }

    return { notes, labels, binders, reminders, attachments, attachmentBlobs };
  }

  private acknowledgeMigrationCutover(migration: MigrationExport, importedResourceCount: number) {
    return firstValueFrom(this.http.post<MigrationCutoverReceipt>(
      `${environment.apiUrl}/v2/migration/cutover`,
      {
        vaultId: migration.vaultId,
        snapshotHash: migration.snapshotHash,
        importedResourceCount
      },
      { headers: this.auth.authHeaders() }
    ));
  }

  private async hydrateLegacyNoteImages(plain: any) {
    const filenames = new Set<string>();
    for (const image of Array.isArray(plain.images) ? plain.images : []) {
      const filename = this.legacyImageFilename(image?.dataUrl);
      if (filename) filenames.add(filename);
    }
    for (const match of String(plain.body || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      const filename = this.legacyImageFilename(match[1]);
      if (filename) filenames.add(filename);
    }
    if (!filenames.size) return plain;

    const dataUrls = new Map<string, string>();
    for (const filename of filenames) {
      const dataUrl = await this.fetchLegacyImageDataUrl(filename);
      if (dataUrl) dataUrls.set(filename, dataUrl);
    }

    return {
      ...plain,
      images: (Array.isArray(plain.images) ? plain.images : []).map((image: any) => {
        const filename = this.legacyImageFilename(image?.dataUrl);
        return filename && dataUrls.has(filename)
          ? { ...image, dataUrl: dataUrls.get(filename) }
          : image;
      }),
      body: String(plain.body || '').replace(/(<img[^>]+src=["'])([^"']+)(["'])/gi, (match, before, src, after) => {
        const filename = this.legacyImageFilename(src);
        return filename && dataUrls.has(filename)
          ? `${before}${dataUrls.get(filename)}${after}`
          : match;
      })
    };
  }

  private async fetchLegacyAttachmentBlob(syncId: string) {
    try {
      const blob = await firstValueFrom(this.http.get(
        `${environment.apiUrl}/v2/migration/attachments/${encodeURIComponent(syncId)}/blob`,
        {
          headers: this.auth.authHeaders(),
          responseType: 'blob'
        }
      ));
      return blob.size ? blob : undefined;
    } catch {
      this.migrationWarnings.push(`Attachment file ${syncId} could not be imported; metadata was kept.`);
      return undefined;
    }
  }

  private async fetchLegacyImageDataUrl(filename: string) {
    try {
      const blob = await firstValueFrom(this.http.get(
        `${environment.apiUrl}/v2/migration/images/${encodeURIComponent(filename)}/blob`,
        {
          headers: this.auth.authHeaders(),
          responseType: 'blob'
        }
      ));
      if (!blob.size) return '';
      return await this.blobToDataUrl(blob);
    } catch {
      this.migrationWarnings.push(`Image file ${filename} could not be imported; the original image reference was kept.`);
      return '';
    }
  }

  private legacyImageFilename(value: string) {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('data:')) return '';
    let pathname = raw;
    try {
      pathname = new URL(raw, window.location.origin).pathname;
    } catch {}
    const match = pathname.match(/^(?:\/uploads\/|\/api\/uploads\/images\/)([^/?#]+)$/);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read image blob.'));
      reader.readAsDataURL(blob);
    });
  }

  private downloadJson(filename: string, value: unknown) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  private defaultDeviceLabel() {
    const platform = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 'iOS'
      : /Android/.test(navigator.userAgent) ? 'Android'
      : 'Web';
    return `${platform} device`;
  }

  private transport() {
    return new EncryptedSelfHostedTransport(
      this.http,
      environment.apiUrl,
      () => this.auth.authHeaders()
    );
  }

  private async importRemoteGrant(grant: KeyGrant) {
    return await this.resourceKeys.importGrant(grant) || await this.devicePairing.importDeviceGrant(grant);
  }
}
