import { Injectable } from '@angular/core';
import { LabelI } from '../interfaces/labels';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import { DurableVaultStoreService } from './durable-vault-store.service';
import { VaultCryptoService } from './vault-crypto.service';
import {
  BinderResource,
  EncryptedEnvelope,
  Kept2LocalResourceKind,
  Kept2OutboxEntry,
  Kept2ResourceType,
  KeyGrant,
  SyncTransport
} from './vault-types';

export type Kept2KeyResolver = (resourceId: string, resourceType: Kept2ResourceType) => Promise<Uint8Array>;
export type Kept2GrantResolver = (vaultId: string, resourceId: string, resourceType: Kept2ResourceType) => Promise<KeyGrant>;

export interface Kept2PullResult {
  applied: number;
  failed: number;
  cursor: number;
  hasMore: boolean;
}

@Injectable({ providedIn: 'root' })
export class SyncEngineService {
  constructor(
    private vault: DurableVaultStoreService,
    private crypto: VaultCryptoService
  ) {}

  async pushOutbox(vaultId: string, transport: SyncTransport, keyFor: Kept2KeyResolver, grantFor?: Kept2GrantResolver) {
    const pending = await this.vault.listOutbox();
    if (!pending.length) return { pushed: 0, removed: 0, failed: 0 };

    const blobUploads = pending.filter(entry => entry.mutationType === 'blob.put');
    const blobDeletes = pending.filter(entry => entry.mutationType === 'blob.delete');
    const resourceMutations = pending.filter(entry => entry.mutationType !== 'blob.put' && entry.mutationType !== 'blob.delete');
    const removable: string[] = [];
    let failed = 0;

    for (const entry of blobUploads) {
      try {
        await this.pushBlob(vaultId, entry, transport, keyFor);
        if (grantFor) {
          const grantMutation = await this.keyGrantMutation(vaultId, entry, 'blob', grantFor);
          const grantResult = await transport.mutate(vaultId, [grantMutation]);
          if (!grantResult[0]?.ok) throw new Error(grantResult[0]?.error || 'Could not sync blob key grant.');
        }
        removable.push(entry.operationId);
      } catch {
        failed += 1;
      }
    }

    const encoded = await Promise.all([...resourceMutations, ...blobDeletes].map(entry => this.encodeOutboxEntry(entry, keyFor)));
    const grantMutations = grantFor
      ? await this.keyGrantMutations(vaultId, resourceMutations, grantFor)
      : [];
    const results = encoded.length || grantMutations.length ? await transport.mutate(vaultId, [...grantMutations, ...encoded]) : [];
    removable.push(...results.filter(result => result.ok).map(result => result.operationId));
    const localOperationIds = new Set([...resourceMutations, ...blobDeletes].map(entry => entry.operationId));
    const removableLocal = removable.filter(operationId => localOperationIds.has(operationId) || blobUploads.some(entry => entry.operationId === operationId));
    await this.vault.removeOutbox(removableLocal);
    return {
      pushed: encoded.length + blobUploads.length,
      removed: removableLocal.length,
      failed: failed + results.filter(result => !result.ok).length
    };
  }

  async pullChanges(
    vaultId: string,
    transport: SyncTransport,
    keyFor: Kept2KeyResolver,
    importGrant?: (grant: KeyGrant) => Promise<boolean>
  ) {
    const cursorName = `remote:${vaultId}`;
    const cursor = await this.vault.getCursor(cursorName);
    if (importGrant) await this.importRemoteKeyGrants(vaultId, transport, importGrant);
    const changes = await transport.changes(vaultId, cursor);
    let applied = 0;
    let failed = 0;
    for (const change of changes.changes) {
      try {
        if (change.operation === 'delete') {
          await this.applyRemoteDelete(change.resourceId, change.resourceType, change.lww);
        } else if (change.envelope) {
          await this.applyRemoteEnvelope(vaultId, transport, change.envelope, keyFor);
        }
        applied += 1;
      } catch {
        failed += 1;
      }
    }
    await this.vault.setCursor(cursorName, changes.cursor);
    return {
      applied,
      failed,
      cursor: changes.cursor,
      hasMore: changes.hasMore
    } satisfies Kept2PullResult;
  }

  async bootstrapRemote(
    vaultId: string,
    transport: SyncTransport,
    keyFor: Kept2KeyResolver,
    importGrant?: (grant: KeyGrant) => Promise<boolean>
  ) {
    const snapshot = await transport.bootstrap(vaultId);
    if (importGrant) {
      for (const grant of snapshot.keyGrants || []) {
        try { await importGrant(grant); } catch {}
      }
    }
    let applied = 0;
    let failed = 0;
    for (const envelope of snapshot.envelopes) {
      try {
        await this.applyRemoteEnvelope(vaultId, transport, envelope, keyFor);
        applied += 1;
      } catch {
        failed += 1;
      }
    }
    await this.vault.setCursor(`remote:${vaultId}`, snapshot.cursor);
    return {
      applied,
      failed,
      cursor: snapshot.cursor,
      hasMore: false
    } satisfies Kept2PullResult;
  }

  async importRemoteKeyGrants(vaultId: string, transport: SyncTransport, importGrant: (grant: KeyGrant) => Promise<boolean>) {
    const snapshot = await transport.bootstrap(vaultId);
    let imported = 0;
    let failed = 0;
    for (const grant of snapshot.keyGrants || []) {
      try {
        if (await importGrant(grant)) imported += 1;
      } catch {
        failed += 1;
      }
    }
    return { imported, failed, cursor: snapshot.cursor };
  }

  private async encodeOutboxEntry(entry: Kept2OutboxEntry, keyFor: Kept2KeyResolver): Promise<Kept2OutboxEntry> {
    if (entry.mutationType === 'blob.delete') {
      return {
        ...entry,
        payload: {
          resourceType: 'blob'
        }
      };
    }
    if (entry.mutationType === 'resource.delete') {
      const kind = this.localKind(entry.payload);
      return {
        ...entry,
        payload: {
          resourceType: this.resourceTypeForKind(kind)
        }
      };
    }
    if (entry.mutationType !== 'resource.upsert') return entry;
    const kind = this.localKind(entry.payload);
    const resourceType = this.resourceTypeForKind(kind);
    const key = await keyFor(entry.resourceId, resourceType);
    const envelope = await this.crypto.encryptJson(
      entry.resourceId,
      resourceType,
      this.localValue(entry.payload),
      key,
      entry.lww
    );
    return {
      ...entry,
      payload: { envelope }
    };
  }

  private async pushBlob(
    vaultId: string,
    entry: Kept2OutboxEntry,
    transport: SyncTransport,
    keyFor: Kept2KeyResolver
  ) {
    const blobKey = String((entry.payload as { blobKey?: string })?.blobKey || '');
    if (!blobKey) throw new Error('blob.put payload is missing blobKey.');
    const blob = await this.vault.getBlob(blobKey);
    if (!blob) throw new Error('blob.put payload references a missing local blob.');
    const key = await keyFor(entry.resourceId, 'blob');
    const sealed = await this.crypto.encryptBlob(entry.resourceId, blob, key);
    await transport.uploadBlob(vaultId, entry.resourceId, sealed.ciphertext, sealed.ciphertextHash);
  }

  private async applyRemoteEnvelope(
    vaultId: string,
    transport: SyncTransport,
    envelope: EncryptedEnvelope,
    keyFor: Kept2KeyResolver
  ) {
    const key = await keyFor(envelope.resourceId, envelope.resourceType);
    const value = await this.crypto.decryptJson<unknown>(envelope, key);
    if (envelope.resourceType === 'note.content') {
      await this.vault.putNote(value as NoteI, envelope.lww);
    } else if (envelope.resourceType === 'reminder') {
      await this.vault.putReminder(value as ReminderI, envelope.lww);
    } else if (envelope.resourceType === 'attachment') {
      const attachment = value as NoteAttachmentI;
      await this.vault.putAttachment(attachment, undefined, envelope.lww);
      await this.pullAttachmentBlob(vaultId, transport, envelope.resourceId, attachment, keyFor, envelope.lww);
    } else if (envelope.resourceType === 'label') {
      await this.vault.putLabel(value as LabelI & { syncId?: string }, envelope.lww);
    } else if (envelope.resourceType === 'binder') {
      await this.vault.putBinder(value as BinderResource, envelope.lww);
    }
  }

  private async pullAttachmentBlob(
    vaultId: string,
    transport: SyncTransport,
    resourceId: string,
    attachment: NoteAttachmentI,
    keyFor: Kept2KeyResolver,
    lww: EncryptedEnvelope['lww']
  ) {
    try {
      const encryptedBlob = await transport.downloadBlob(vaultId, resourceId);
      const key = await keyFor(resourceId, 'blob');
      const blob = await this.crypto.decryptBlob(resourceId, encryptedBlob, key, attachment.mimeType || 'application/octet-stream');
      await this.vault.putAttachment(attachment, blob, lww);
    } catch {
      // Attachment metadata is still useful if the blob has not arrived yet or
      // this device does not have the blob grant. A later sync/bootstrap can retry.
    }
  }

  private async applyRemoteDelete(resourceId: string, resourceType: Kept2ResourceType, lww: EncryptedEnvelope['lww']) {
    if (resourceType === 'note.content') await this.vault.deleteNote(resourceId, lww);
    if (resourceType === 'reminder') await this.vault.deleteReminder(resourceId, lww);
    if (resourceType === 'attachment') await this.vault.deleteAttachment(resourceId, lww);
    if (resourceType === 'blob') await this.vault.deleteBlob(`attachment:${resourceId}`);
    if (resourceType === 'label') await this.vault.deleteLabel(resourceId, lww);
    if (resourceType === 'binder') await this.vault.deleteBinder(resourceId, lww);
  }

  private localKind(payload: unknown): Kept2LocalResourceKind {
    const kind = String((payload as { localResourceKind?: string })?.localResourceKind || '');
    if (kind === 'note' || kind === 'reminder' || kind === 'attachment' || kind === 'label' || kind === 'binder') return kind;
    return 'note';
  }

  private localValue(payload: unknown) {
    return (payload as { value?: unknown })?.value;
  }

  private resourceTypeForKind(kind: Kept2LocalResourceKind): Kept2ResourceType {
    if (kind === 'reminder') return 'reminder';
    if (kind === 'attachment') return 'attachment';
    if (kind === 'label') return 'label';
    if (kind === 'binder') return 'binder';
    return 'note.content';
  }

  private async keyGrantMutations(vaultId: string, entries: Kept2OutboxEntry[], grantFor: Kept2GrantResolver) {
    const mutations: Kept2OutboxEntry[] = [];
    for (const entry of entries) {
      if (entry.mutationType !== 'resource.upsert') continue;
      const kind = this.localKind(entry.payload);
      mutations.push(await this.keyGrantMutation(vaultId, entry, this.resourceTypeForKind(kind), grantFor));
    }
    return mutations;
  }

  private async keyGrantMutation(
    vaultId: string,
    entry: Kept2OutboxEntry,
    resourceType: Kept2ResourceType,
    grantFor: Kept2GrantResolver
  ): Promise<Kept2OutboxEntry> {
    const grant = await grantFor(vaultId, entry.resourceId, resourceType);
    return {
      operationId: `${entry.operationId}:grant:${grant.grantId}`.slice(0, 180),
      mutationType: 'keyGrant.upsert',
      resourceId: grant.grantId,
      payload: { grant },
      lww: entry.lww,
      createdAt: entry.createdAt,
      attempts: entry.attempts
    };
  }
}
