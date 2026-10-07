import { Injectable } from '@angular/core';
import { LabelI } from '../interfaces/labels';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import {
  BinderResource,
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

type StoredLww = {
  lwwPhysicalMs: number;
  lwwLogical: number;
  lwwDeviceId: string;
  lwwOperationId: string;
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

  async searchNotes(query: string): Promise<NoteI[]> {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.listNotes();
    const clauses = terms.map(() => `searchText LIKE ? ESCAPE '\\'`).join(' AND ');
    const params = terms.map(term => `%${this.escapeLike(term)}%`);
    const rows = await this.driver.all<StoredJson<NoteI>>(
      `SELECT syncId, value FROM notes
       WHERE deleted = 0 AND ${clauses}
       ORDER BY updatedAt DESC`,
      params
    );
    return rows.map(row => this.parseJson<NoteI>(row.value));
  }

  private escapeLike(value: string) {
    return value.replace(/[\\%_]/g, match => `\\${match}`);
  }

  async putNote(note: NoteI, stamp?: LwwStamp): Promise<void> {
    const syncId = this.ensureSyncId(note, 'note');
    const now = new Date().toISOString();
    const lww = this.stamp(stamp);
    if (!(await this.shouldApply('notes', syncId, lww))) return;
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
    if (!(await this.shouldApply('notes', syncId, lww))) return;
    await this.driver.run(
      `INSERT INTO notes
       (syncId, value, searchText, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
       VALUES (?, ?, '', ?, ?, ?, ?, 1, ?)
       ON CONFLICT(syncId) DO UPDATE SET
         lwwPhysicalMs = excluded.lwwPhysicalMs,
         lwwLogical = excluded.lwwLogical,
         lwwDeviceId = excluded.lwwDeviceId,
         lwwOperationId = excluded.lwwOperationId,
         deleted = 1,
         updatedAt = excluded.updatedAt`,
      [syncId, JSON.stringify({ syncId }), lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, new Date().toISOString()]
    );
  }

  async listLabels(): Promise<Array<LabelI & { syncId?: string }>> {
    const rows = await this.driver.all<StoredJson<LabelI & { syncId?: string }>>(
      'SELECT syncId, value FROM labels WHERE deleted = 0 ORDER BY name COLLATE NOCASE ASC'
    );
    return rows.map(row => this.parseJson<LabelI & { syncId?: string }>(row.value));
  }

  async putLabel(label: LabelI & { syncId?: string }, stamp?: LwwStamp): Promise<void> {
    const syncId = this.ensureSyncId(label, 'label');
    const now = new Date().toISOString();
    const lww = this.stamp(stamp);
    if (!(await this.shouldApply('labels', syncId, lww))) return;
    const value = { ...label, syncId, name: String(label.name || '').trim() };
    await this.driver.run(
      `INSERT INTO labels
       (syncId, name, value, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(syncId) DO UPDATE SET
         name = excluded.name,
         value = excluded.value,
         lwwPhysicalMs = excluded.lwwPhysicalMs,
         lwwLogical = excluded.lwwLogical,
         lwwDeviceId = excluded.lwwDeviceId,
         lwwOperationId = excluded.lwwOperationId,
         deleted = 0,
         updatedAt = excluded.updatedAt`,
      [syncId, value.name, JSON.stringify(value), lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, now]
    );
  }

  async deleteLabel(syncId: string, stamp?: LwwStamp): Promise<void> {
    const lww = this.stamp(stamp);
    if (!(await this.shouldApply('labels', syncId, lww))) return;
    await this.driver.run(
      `INSERT INTO labels
       (syncId, name, value, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
       VALUES (?, '', ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(syncId) DO UPDATE SET
         lwwPhysicalMs = excluded.lwwPhysicalMs,
         lwwLogical = excluded.lwwLogical,
         lwwDeviceId = excluded.lwwDeviceId,
         lwwOperationId = excluded.lwwOperationId,
         deleted = 1,
         updatedAt = excluded.updatedAt`,
      [syncId, JSON.stringify({ syncId, name: '' }), lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, new Date().toISOString()]
    );
  }

  async listBinders(): Promise<BinderResource[]> {
    const rows = await this.driver.all<StoredJson<BinderResource>>(
      'SELECT syncId, value FROM binders WHERE deleted = 0 ORDER BY name COLLATE NOCASE ASC'
    );
    return rows.map(row => this.parseJson<BinderResource>(row.value));
  }

  async putBinder(binder: BinderResource, stamp?: LwwStamp): Promise<void> {
    const syncId = this.ensureSyncId(binder, 'binder');
    const now = new Date().toISOString();
    const lww = this.stamp(stamp);
    if (!(await this.shouldApply('binders', syncId, lww))) return;
    const value = { ...binder, syncId, name: String(binder.name || '').trim(), updatedAt: binder.updatedAt || now };
    await this.driver.run(
      `INSERT INTO binders
       (syncId, name, value, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(syncId) DO UPDATE SET
         name = excluded.name,
         value = excluded.value,
         lwwPhysicalMs = excluded.lwwPhysicalMs,
         lwwLogical = excluded.lwwLogical,
         lwwDeviceId = excluded.lwwDeviceId,
         lwwOperationId = excluded.lwwOperationId,
         deleted = 0,
         updatedAt = excluded.updatedAt`,
      [syncId, value.name, JSON.stringify(value), lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, now]
    );
  }

  async deleteBinder(syncId: string, stamp?: LwwStamp): Promise<void> {
    const lww = this.stamp(stamp);
    if (!(await this.shouldApply('binders', syncId, lww))) return;
    await this.driver.run(
      `INSERT INTO binders
       (syncId, name, value, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
       VALUES (?, '', ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(syncId) DO UPDATE SET
         lwwPhysicalMs = excluded.lwwPhysicalMs,
         lwwLogical = excluded.lwwLogical,
         lwwDeviceId = excluded.lwwDeviceId,
         lwwOperationId = excluded.lwwOperationId,
         deleted = 1,
         updatedAt = excluded.updatedAt`,
      [syncId, JSON.stringify({ syncId, name: '' }), lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, new Date().toISOString()]
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
    if (!(await this.shouldApply('reminders', syncId, lww))) return;
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
    if (!(await this.shouldApply('reminders', syncId, lww))) return;
    await this.driver.run(
      `INSERT INTO reminders
       (syncId, noteSyncId, value, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
       VALUES (?, '', ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(syncId) DO UPDATE SET
         lwwPhysicalMs = excluded.lwwPhysicalMs,
         lwwLogical = excluded.lwwLogical,
         lwwDeviceId = excluded.lwwDeviceId,
         lwwOperationId = excluded.lwwOperationId,
         deleted = 1,
         updatedAt = excluded.updatedAt`,
      [syncId, JSON.stringify({ syncId }), lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, new Date().toISOString()]
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
    if (!(await this.shouldApply('attachments', syncId, lww))) return;
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
    if (!(await this.shouldApply('attachments', syncId, lww))) return;
    const row = await this.driver.get<{ blobKey?: string }>('SELECT blobKey FROM attachments WHERE syncId = ?', [syncId]);
    await this.driver.transaction(async () => {
      await this.driver.run(
        `INSERT INTO attachments
         (syncId, noteSyncId, blobKey, value, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, deleted, updatedAt)
         VALUES (?, '', '', ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(syncId) DO UPDATE SET
           lwwPhysicalMs = excluded.lwwPhysicalMs,
           lwwLogical = excluded.lwwLogical,
           lwwDeviceId = excluded.lwwDeviceId,
           lwwOperationId = excluded.lwwOperationId,
           deleted = 1,
           updatedAt = excluded.updatedAt`,
        [syncId, JSON.stringify({ syncId }), lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, new Date().toISOString()]
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

  private async shouldApply(
    table: 'notes' | 'reminders' | 'labels' | 'binders' | 'attachments',
    syncId: string,
    incoming: LwwStamp
  ) {
    const existing = await this.driver.get<StoredLww>(
      `SELECT lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId FROM ${table} WHERE syncId = ?`,
      [syncId]
    );
    return !existing || this.compareLww(incoming, existing) >= 0;
  }

  private compareLww(left: LwwStamp, right: StoredLww) {
    const values: Array<[number | string, number | string]> = [
      [Number(left.physicalMs || 0), Number(right.lwwPhysicalMs || 0)],
      [Number(left.logical || 0), Number(right.lwwLogical || 0)],
      [String(left.deviceId || ''), String(right.lwwDeviceId || '')],
      [String(left.operationId || ''), String(right.lwwOperationId || '')]
    ];
    for (const [a, b] of values) {
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  }

  private ensureSyncId(value: { syncId?: string }, prefix: 'note' | 'reminder' | 'attachment' | 'label' | 'binder') {
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
