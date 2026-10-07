import { Injectable } from '@angular/core';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import { DurableVaultStoreService } from './durable-vault-store.service';
import { Kept2MutationType, LwwStamp, VaultIdentity } from './vault-types';

type LocalResourceKind = 'note' | 'reminder' | 'attachment';

@Injectable({ providedIn: 'root' })
export class LocalFirstVaultService {
  private lastPhysicalMs = 0;
  private lastLogical = 0;
  private cachedIdentity?: Promise<VaultIdentity>;

  constructor(private vault: DurableVaultStoreService) {}

  notes() {
    return this.vault.listNotes();
  }

  async createNote(input: Partial<NoteI>) {
    const now = new Date().toISOString();
    const note: NoteI = {
      noteTitle: input.noteTitle || '',
      noteBody: input.noteBody || '',
      pinned: input.pinned ?? false,
      bgColor: input.bgColor || '',
      bgImage: input.bgImage || '',
      checkBoxes: input.checkBoxes || [],
      images: input.images || [],
      isCbox: input.isCbox ?? false,
      labels: input.labels || [],
      binder: input.binder || '',
      archived: input.archived ?? false,
      trashed: input.trashed ?? false,
      createdAt: input.createdAt || now,
      updatedAt: now,
      syncId: input.syncId || `note-${crypto.randomUUID()}`
    };
    const stamp = await this.nextStamp();
    await this.vault.putNote(note, stamp);
    await this.enqueueLocalMutation('resource.upsert', note.syncId!, 'note', note, stamp);
    return note;
  }

  async updateNote(syncId: string, patch: Partial<NoteI>) {
    const existing = await this.vault.getNote(syncId);
    if (!existing) throw new Error('Note not found in local vault.');
    const note: NoteI = {
      ...existing,
      ...patch,
      syncId,
      updatedAt: new Date().toISOString()
    };
    const stamp = await this.nextStamp();
    await this.vault.putNote(note, stamp);
    await this.enqueueLocalMutation('resource.upsert', syncId, 'note', note, stamp);
    return note;
  }

  async deleteNote(syncId: string) {
    const stamp = await this.nextStamp();
    await this.vault.deleteNote(syncId, stamp);
    await this.enqueueLocalMutation('resource.delete', syncId, 'note', { syncId }, stamp);
  }

  reminders() {
    return this.vault.listReminders();
  }

  async upsertReminder(input: ReminderI & { noteSyncId?: string }) {
    input.syncId ||= `reminder-${crypto.randomUUID()}`;
    const stamp = await this.nextStamp();
    await this.vault.putReminder(input, stamp);
    await this.enqueueLocalMutation('resource.upsert', input.syncId, 'reminder', input, stamp);
    return input;
  }

  async deleteReminder(syncId: string) {
    const stamp = await this.nextStamp();
    await this.vault.deleteReminder(syncId, stamp);
    await this.enqueueLocalMutation('resource.delete', syncId, 'reminder', { syncId }, stamp);
  }

  attachments(noteSyncId?: string) {
    return this.vault.listAttachments(noteSyncId);
  }

  async upsertAttachment(attachment: NoteAttachmentI & { noteSyncId?: string }, blob?: Blob) {
    attachment.syncId ||= `attachment-${crypto.randomUUID()}`;
    const stamp = await this.nextStamp();
    await this.vault.putAttachment(attachment, blob, stamp);
    await this.enqueueLocalMutation('resource.upsert', attachment.syncId, 'attachment', attachment, stamp);
    if (blob) {
      const blobStamp = await this.nextStamp();
      await this.vault.enqueue({
        operationId: blobStamp.operationId,
        mutationType: 'blob.put',
        resourceId: attachment.syncId,
        payload: {
          localResourceKind: 'blob',
          blobKey: `attachment:${attachment.syncId}`
        },
        lww: blobStamp,
        createdAt: new Date().toISOString(),
        attempts: 0
      });
    }
    return attachment;
  }

  async deleteAttachment(syncId: string) {
    const stamp = await this.nextStamp();
    const blobStamp = await this.nextStamp();
    await this.vault.enqueue({
      operationId: blobStamp.operationId,
      mutationType: 'blob.delete',
      resourceId: syncId,
      payload: {
        localResourceKind: 'blob',
        blobKey: `attachment:${syncId}`
      },
      lww: blobStamp,
      createdAt: new Date().toISOString(),
      attempts: 0
    });
    await this.vault.deleteAttachment(syncId, stamp);
    await this.enqueueLocalMutation('resource.delete', syncId, 'attachment', { syncId }, stamp);
  }

  outbox() {
    return this.vault.listOutbox();
  }

  private async enqueueLocalMutation(
    mutationType: Kept2MutationType,
    resourceId: string,
    resourceKind: LocalResourceKind,
    value: unknown,
    lww: LwwStamp
  ) {
    await this.vault.enqueue({
      operationId: lww.operationId,
      mutationType,
      resourceId,
      payload: {
        localResourceKind: resourceKind,
        value
      },
      lww,
      createdAt: new Date().toISOString(),
      attempts: 0
    });
  }

  private async nextStamp(): Promise<LwwStamp> {
    const identity = await this.identity();
    const now = Date.now();
    if (now > this.lastPhysicalMs) {
      this.lastPhysicalMs = now;
      this.lastLogical = 0;
    } else {
      this.lastLogical += 1;
    }
    return {
      physicalMs: this.lastPhysicalMs,
      logical: this.lastLogical,
      deviceId: identity.deviceId,
      operationId: crypto.randomUUID()
    };
  }

  private identity() {
    this.cachedIdentity ||= this.vault.identity();
    return this.cachedIdentity;
  }
}
