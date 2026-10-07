import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NoteAttachmentI, NoteI } from 'src/app/interfaces/notes';
import { ReminderI } from 'src/app/interfaces/reminder';
import { LocalFirstVaultService } from 'src/app/kept2/local-first-vault.service';
import { Kept2SyncCoordinatorService } from 'src/app/kept2/kept2-sync-coordinator.service';
import { SyncEngineService } from 'src/app/kept2/sync-engine.service';
import { EncryptedSelfHostedTransport } from 'src/app/kept2/sync-transport';
import { VaultResourceKeyService } from 'src/app/kept2/vault-resource-key.service';
import { VaultSessionService } from 'src/app/kept2/vault-session.service';
import { VaultIdentity } from 'src/app/kept2/vault-types';
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

  constructor(
    private auth: AuthService,
    private http: HttpClient,
    private vaultSession: VaultSessionService,
    private localVault: LocalFirstVaultService,
    private resourceKeys: VaultResourceKeyService,
    private syncCoordinator: Kept2SyncCoordinatorService,
    private syncEngine: SyncEngineService
  ) {}

  async ngOnInit() {
    this.hasVault = await this.vaultSession.hasLocalVault();
    this.identity = this.vaultSession.currentSession()?.identity || null;
    this.mode = this.hasVault ? 'unlock' : 'create';
    if (this.identity) {
      this.syncCoordinator.start(this.identity);
      await this.refreshLocalState();
    }
  }

  ngOnDestroy() {
    this.syncCoordinator.stop();
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
        grant => this.resourceKeys.importGrant(grant)
      );
      this.syncStatus = `Pulled ${result.applied} remote change${result.applied === 1 ? '' : 's'}${result.failed ? `; ${result.failed} could not be decrypted on this device yet` : ''}.`;
      await this.refreshLocalState();
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
        grant => this.resourceKeys.importGrant(grant)
      );
      this.syncStatus = `Bootstrapped ${result.applied} encrypted resource${result.applied === 1 ? '' : 's'}${result.failed ? `; ${result.failed} could not be decrypted on this device yet` : ''}.`;
      await this.refreshLocalState();
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
      this.migrationWarnings = [
        ...(migration.warnings || []).map(warning => warning.code),
        ...(migration.limitations || [])
      ];
      this.migrationStatus = `Imported ${imported.notes} note${imported.notes === 1 ? '' : 's'}, ${imported.reminders} reminder${imported.reminders === 1 ? '' : 's'}, ${imported.attachments} attachment record${imported.attachments === 1 ? '' : 's'}, and ${imported.attachmentBlobs} attachment file${imported.attachmentBlobs === 1 ? '' : 's'} into the local vault.`;
      await this.refreshLocalState();
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not import legacy notes.';
    } finally {
      this.isBusy = false;
    }
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

  private async refreshLocalState() {
    this.notes = await this.localVault.notes();
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

    return { notes, reminders, attachments, attachmentBlobs };
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

  private transport() {
    return new EncryptedSelfHostedTransport(
      this.http,
      environment.apiUrl,
      () => this.auth.authHeaders()
    );
  }
}
