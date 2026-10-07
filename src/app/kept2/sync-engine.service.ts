import { Injectable } from '@angular/core';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import { DurableVaultStoreService } from './durable-vault-store.service';
import { VaultCryptoService } from './vault-crypto.service';
import {
  EncryptedEnvelope,
  Kept2LocalResourceKind,
  Kept2OutboxEntry,
  Kept2ResourceType,
  SyncTransport
} from './vault-types';

export type Kept2KeyResolver = (resourceId: string, resourceType: Kept2ResourceType) => Promise<Uint8Array>;

@Injectable({ providedIn: 'root' })
export class SyncEngineService {
  constructor(
    private vault: DurableVaultStoreService,
    private crypto: VaultCryptoService
  ) {}

  async pushOutbox(vaultId: string, transport: SyncTransport, keyFor: Kept2KeyResolver) {
    const pending = await this.vault.listOutbox();
    if (!pending.length) return { pushed: 0, removed: 0, failed: 0 };
    const encoded = await Promise.all(pending.map(entry => this.encodeOutboxEntry(entry, keyFor)));
    const results = await transport.mutate(vaultId, encoded);
    const removable = results.filter(result => result.ok).map(result => result.operationId);
    await this.vault.removeOutbox(removable);
    return {
      pushed: encoded.length,
      removed: removable.length,
      failed: results.filter(result => !result.ok).length
    };
  }

  async pullChanges(vaultId: string, transport: SyncTransport, keyFor: Kept2KeyResolver) {
    const cursorName = `remote:${vaultId}`;
    const cursor = await this.vault.getCursor(cursorName);
    const changes = await transport.changes(vaultId, cursor);
    for (const change of changes.changes) {
      if (change.operation === 'delete') {
        await this.applyRemoteDelete(change.resourceId, change.resourceType);
      } else if (change.envelope) {
        await this.applyRemoteEnvelope(change.envelope, keyFor);
      }
    }
    await this.vault.setCursor(cursorName, changes.cursor);
    return {
      applied: changes.changes.length,
      cursor: changes.cursor,
      hasMore: changes.hasMore
    };
  }

  private async encodeOutboxEntry(entry: Kept2OutboxEntry, keyFor: Kept2KeyResolver): Promise<Kept2OutboxEntry> {
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

  private async applyRemoteEnvelope(envelope: EncryptedEnvelope, keyFor: Kept2KeyResolver) {
    const key = await keyFor(envelope.resourceId, envelope.resourceType);
    const value = await this.crypto.decryptJson<unknown>(envelope, key);
    if (envelope.resourceType === 'note.content') {
      await this.vault.putNote(value as NoteI, envelope.lww);
    } else if (envelope.resourceType === 'reminder') {
      await this.vault.putReminder(value as ReminderI, envelope.lww);
    } else if (envelope.resourceType === 'attachment') {
      await this.vault.putAttachment(value as NoteAttachmentI, undefined, envelope.lww);
    }
  }

  private async applyRemoteDelete(resourceId: string, resourceType: Kept2ResourceType) {
    if (resourceType === 'note.content') await this.vault.deleteNote(resourceId);
    if (resourceType === 'reminder') await this.vault.deleteReminder(resourceId);
    if (resourceType === 'attachment') await this.vault.deleteAttachment(resourceId);
  }

  private localKind(payload: unknown): Kept2LocalResourceKind {
    const kind = String((payload as { localResourceKind?: string })?.localResourceKind || '');
    if (kind === 'note' || kind === 'reminder' || kind === 'attachment') return kind;
    return 'note';
  }

  private localValue(payload: unknown) {
    return (payload as { value?: unknown })?.value;
  }

  private resourceTypeForKind(kind: Kept2LocalResourceKind): Kept2ResourceType {
    if (kind === 'reminder') return 'reminder';
    if (kind === 'attachment') return 'attachment';
    return 'note.content';
  }
}
