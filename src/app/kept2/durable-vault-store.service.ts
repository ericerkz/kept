import { Injectable } from '@angular/core';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import {
  DurableVaultStore,
  Kept2OutboxEntry,
  LwwStamp,
  VaultIdentity
} from './vault-types';
import { VaultIdentityService } from './vault-identity.service';

@Injectable({ providedIn: 'root' })
export class DurableVaultStoreService implements DurableVaultStore {
  constructor(private identities: VaultIdentityService) {}

  identity(): Promise<VaultIdentity> {
    return this.identities.loadOrCreate();
  }

  listNotes(): Promise<NoteI[]> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  putNote(_note: NoteI, _stamp?: LwwStamp): Promise<void> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  getNote(_syncId: string): Promise<NoteI | undefined> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  deleteNote(_syncId: string, _stamp?: LwwStamp): Promise<void> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  listReminders(): Promise<ReminderI[]> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  putReminder(_reminder: ReminderI, _stamp?: LwwStamp): Promise<void> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  deleteReminder(_syncId: string, _stamp?: LwwStamp): Promise<void> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  listAttachments(_noteSyncId?: string): Promise<NoteAttachmentI[]> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  putAttachment(_attachment: NoteAttachmentI, _blob?: Blob, _stamp?: LwwStamp): Promise<void> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  deleteAttachment(_syncId: string, _stamp?: LwwStamp): Promise<void> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  enqueue(_entry: Kept2OutboxEntry): Promise<void> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  listOutbox(): Promise<Kept2OutboxEntry[]> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }

  removeOutbox(_operationIds: string[]): Promise<void> {
    throw new Error('DurableVaultStore SQLite implementation is not wired yet.');
  }
}

