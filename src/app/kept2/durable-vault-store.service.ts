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
import { VaultSqliteDriverService } from './vault-sqlite-driver.service';

type StoredJson<T> = {
  syncId: string;
  value: string;
};

@Injectable({ providedIn: 'root' })
export class DurableVaultStoreService implements DurableVaultStore {
  constructor(
    private identities: VaultIdentityService,
    private driver: VaultSqliteDriverService
  ) {}

  identity(): Promise<VaultIdentity> {
    return this.identities.loadOrCreate();
  }

  async listNotes(): Promise<NoteI[]> {
    const rows = await this.driver.all<StoredJson<NoteI>>(
      'SELECT syncId, value FROM notes WHERE deleted = 0 ORDER BY updatedAt DESC'
    );
    return rows.map(row => this.parseJson<NoteI>(row.value));
  }

  async putNote(note: NoteI, stamp?: LwwStamp): Promise<void> {
    const syncId = this.ensureSyncId(note, 'note');
    const now = new Date().toISOString();
    const lww = this.stamp(stamp);
    const value = { ...note, syncId, updatedAt: note.updatedAt || now };
    await this.driver.run(
      `INSERT INTO notes
       (syncId, value, searchText, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(syncId) DO UPDATE SET
         value = excluded.value,
         searchText = excluded.searchText,
         lwwPhysicalMs = excluded.lwwPhysicalMs,
         lwwLogical = excluded.lwwLogical,
         lwwDeviceId = excluded.lwwDeviceId,
         lwwOperationId = excluded.lwwOperationId,
         deleted = 0,
         updatedAt = excluded.updatedAt`,
      [
        syncId,
        JSON.stringify(value),
        this.noteSearchText(value),
        lww.physicalMs,
        lww.logical,
        lww.deviceId,
        lww.operationId,
        now
      ]
    );
  }

  async getNote(syncId: string): Promise<NoteI | undefined> {
    const row = await this.driver.get<StoredJson<NoteI>>(
      'SELECT syncId, value FROM notes WHERE syncId = ? AND deleted = 0',
      [syncId]
    );
    return row ? this.parseJson<NoteI>(row.value) : undefined;
  }

  async deleteNote(syncId: string, stamp?: LwwStamp): Promise<void> {
    const lww = this.stamp(stamp);
    await this.driver.run(
      `UPDATE notes SET deleted = 1, lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?,
        lwwOperationId = ?, updatedAt = ? WHERE syncId = ?`,
      [lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, new Date().toISOString(), syncId]
    );
  }

  async listReminders(): Promise<ReminderI[]> {
    const rows = await this.driver.all<StoredJson<ReminderI>>(
      'SELECT syncId, value FROM reminders WHERE deleted = 0 ORDER BY updatedAt DESC'
    );
    return rows.map(row => this.parseJson<ReminderI>(row.value));
  }

  async putReminder(reminder: ReminderI, stamp?: LwwStamp): Promise<void> {
    const syncId = this.ensureSyncId(reminder, 'reminder');
    const now = new Date().toISOString();
    const lww = this.stamp(stamp);
    const value = { ...reminder, syncId, updatedAt: reminder.updatedAt || now };
    await this.driver.run(
      `INSERT INTO reminders
       (syncId, noteSyncId, value, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(syncId) DO UPDATE SET
         noteSyncId = excluded.noteSyncId,
         value = excluded.value,
         lwwPhysicalMs = excluded.lwwPhysicalMs,
         lwwLogical = excluded.lwwLogical,
         lwwDeviceId = excluded.lwwDeviceId,
         lwwOperationId = excluded.lwwOperationId,
         deleted = 0,
         updatedAt = excluded.updatedAt`,
      [
        syncId,
        (value as ReminderI & { noteSyncId?: string }).noteSyncId || '',
        JSON.stringify(value),
        lww.physicalMs,
        lww.logical,
        lww.deviceId,
        lww.operationId,
        now
      ]
    );
  }

  async deleteReminder(syncId: string, stamp?: LwwStamp): Promise<void> {
    const lww = this.stamp(stamp);
    await this.driver.run(
      `UPDATE reminders SET deleted = 1, lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?,
        lwwOperationId = ?, updatedAt = ? WHERE syncId = ?`,
      [lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, new Date().toISOString(), syncId]
    );
  }

  async listAttachments(noteSyncId?: string): Promise<NoteAttachmentI[]> {
    const rows = noteSyncId
      ? await this.driver.all<StoredJson<NoteAttachmentI>>(
        'SELECT syncId, value FROM attachments WHERE noteSyncId = ? AND deleted = 0 ORDER BY updatedAt DESC',
        [noteSyncId]
      )
      : await this.driver.all<StoredJson<NoteAttachmentI>>(
        'SELECT syncId, value FROM attachments WHERE deleted = 0 ORDER BY updatedAt DESC'
      );
    return rows.map(row => this.parseJson<NoteAttachmentI>(row.value));
  }

  async putAttachment(attachment: NoteAttachmentI, blob?: Blob, stamp?: LwwStamp): Promise<void> {
    const syncId = this.ensureSyncId(attachment, 'attachment');
    const now = new Date().toISOString();
    const blobKey = blob ? `attachment:${syncId}` : '';
    const lww = this.stamp(stamp);
    const value = { ...attachment, syncId };
    await this.driver.transaction(async () => {
      if (blob) await this.driver.putBlob(blobKey, blob);
      await this.driver.run(
        `INSERT INTO attachments
         (syncId, noteSyncId, blobKey, value, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(syncId) DO UPDATE SET
           noteSyncId = excluded.noteSyncId,
           blobKey = CASE WHEN excluded.blobKey = '' THEN attachments.blobKey ELSE excluded.blobKey END,
           value = excluded.value,
           lwwPhysicalMs = excluded.lwwPhysicalMs,
           lwwLogical = excluded.lwwLogical,
           lwwDeviceId = excluded.lwwDeviceId,
           lwwOperationId = excluded.lwwOperationId,
           deleted = 0,
           updatedAt = excluded.updatedAt`,
        [
          syncId,
          (value as NoteAttachmentI & { noteSyncId?: string }).noteSyncId || '',
          blobKey,
          JSON.stringify(value),
          lww.physicalMs,
          lww.logical,
          lww.deviceId,
          lww.operationId,
          now
        ]
      );
    });
  }

  getBlob(blobKey: string): Promise<Blob | undefined> {
    return this.driver.getBlob(blobKey);
  }

  deleteBlob(blobKey: string): Promise<void> {
    return this.driver.deleteBlob(blobKey);
  }

  async deleteAttachment(syncId: string, stamp?: LwwStamp): Promise<void> {
    const lww = this.stamp(stamp);
    const row = await this.driver.get<{ blobKey?: string }>('SELECT blobKey FROM attachments WHERE syncId = ?', [syncId]);
    await this.driver.transaction(async () => {
      await this.driver.run(
        `UPDATE attachments SET deleted = 1, lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?,
          lwwOperationId = ?, updatedAt = ? WHERE syncId = ?`,
        [lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, new Date().toISOString(), syncId]
      );
      if (row?.blobKey) await this.driver.deleteBlob(row.blobKey);
    });
  }

  async enqueue(entry: Kept2OutboxEntry): Promise<void> {
    await this.driver.run(
      `INSERT INTO outbox (operationId, value, createdAt, attempts)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(operationId) DO UPDATE SET value = excluded.value, attempts = excluded.attempts`,
      [entry.operationId, JSON.stringify(entry), entry.createdAt, entry.attempts]
    );
  }

  async listOutbox(): Promise<Kept2OutboxEntry[]> {
    const rows = await this.driver.all<{ value: string }>('SELECT value FROM outbox ORDER BY createdAt ASC');
    return rows.map(row => this.parseJson<Kept2OutboxEntry>(row.value));
  }

  async removeOutbox(operationIds: string[]): Promise<void> {
    await this.driver.transaction(async () => {
      for (const operationId of operationIds) {
        await this.driver.run('DELETE FROM outbox WHERE operationId = ?', [operationId]);
      }
    });
  }

  async getCursor(name: string): Promise<number> {
    const row = await this.driver.get<{ cursor: number }>('SELECT cursor FROM sync_cursors WHERE name = ?', [name]);
    return Number(row?.cursor || 0);
  }

  async setCursor(name: string, cursor: number): Promise<void> {
    await this.driver.run(
      `INSERT INTO sync_cursors (name, cursor, updatedAt)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor, updatedAt = excluded.updatedAt`,
      [name, Math.max(0, Number(cursor || 0)), new Date().toISOString()]
    );
  }

  private ensureSyncId(value: { syncId?: string }, prefix: 'note' | 'reminder' | 'attachment') {
    value.syncId ||= `${prefix}-${crypto.randomUUID()}`;
    return value.syncId;
  }

  private stamp(stamp?: LwwStamp): LwwStamp {
    return stamp || {
      physicalMs: Date.now(),
      logical: 0,
      deviceId: 'local',
      operationId: crypto.randomUUID()
    };
  }

  private parseJson<T>(value: string): T {
    return JSON.parse(value) as T;
  }

  private noteSearchText(note: NoteI) {
    const checks = (note.checkBoxes || []).map(item => String(item.data || '')).join(' ');
    const labels = (note.labels || []).map(label => label.name).join(' ');
    return [
      note.noteTitle,
      note.noteBody || '',
      checks,
      labels,
      note.binder || ''
    ].join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }
}
