import { Injectable } from '@angular/core';
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import type { LocationSavedPlace } from './location-saved-places.service';

export type SyncResourceType = 'note' | 'reminder' | 'attachment';
export type SyncMutationType =
  | 'note.upsert'
  | 'note.delete'
  | 'note.reorder'
  | 'reminder.upsert'
  | 'reminder.delete'
  | 'attachment.upload'
  | 'attachment.delete';

export interface LwwStamp {
  physicalMs: number;
  logical: number;
  deviceId: string;
  operationId: string;
}

export interface OutboxEntry {
  key: string;
  partition: string;
  operationId: string;
  type: SyncMutationType;
  syncId: string;
  payload: unknown;
  lww: LwwStamp;
  createdAt: number;
  attempts: number;
}

type StoredResource<T> = {
  key: string;
  partition: string;
  syncId: string;
  value: T;
};

type SyncState = {
  key: string;
  partition: string;
  cursor: number;
  serverOffsetMs: number;
};

@Injectable({ providedIn: 'root' })
export class OfflineStoreService {
  private readonly databaseName = 'kept-offline-v1';
  private readonly databaseVersion = 2;
  private database?: Promise<IDBDatabase>;
  private lastStampPhysicalMs = 0;
  private lastStampLogical = 0;

  partition(userId: number) {
    const api = environment.apiUrl || '/api';
    let server = api;
    try {
      server = new URL(api, window.location.origin).origin + new URL(api, window.location.origin).pathname;
    } catch {}
    return `${server}|${userId}`;
  }

  deviceId() {
    const key = 'kept_offline_device_id';
    let value = localStorage.getItem(key);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(key, value);
    }
    return value;
  }

  nextStamp(serverOffsetMs = 0): LwwStamp {
    const now = Date.now() + serverOffsetMs;
    if (now > this.lastStampPhysicalMs) {
      this.lastStampPhysicalMs = now;
      this.lastStampLogical = 0;
    } else {
      this.lastStampLogical += 1;
    }
    return {
      physicalMs: this.lastStampPhysicalMs,
      logical: this.lastStampLogical,
      deviceId: this.deviceId(),
      operationId: crypto.randomUUID()
    };
  }

  ensureNoteIdentity(note: NoteI) {
    if (!note.syncId) note.syncId = `note-${crypto.randomUUID()}`;
    return note.syncId;
  }

  ensureReminderIdentity(reminder: Partial<ReminderI>) {
    if (!reminder.syncId) reminder.syncId = `reminder-${crypto.randomUUID()}`;
    return reminder.syncId;
  }

  async replaceSnapshot(partition: string, notes: NoteI[], reminders: ReminderI[], attachments: NoteAttachmentI[], cursor: number, serverTime: number) {
    const db = await this.open();
    await Promise.all([
      this.clearPartitionStore(db, 'notes', partition),
      this.clearPartitionStore(db, 'reminders', partition),
      this.clearPartitionStore(db, 'attachments', partition)
    ]);
    await this.transaction(db, ['notes', 'reminders', 'attachments', 'syncState'], 'readwrite', stores => {
      notes.forEach(note => {
        const syncId = this.ensureNoteIdentity(note);
        stores['notes'].put({ key: this.resourceKey(partition, syncId), partition, syncId, value: note });
      });
      reminders.forEach(reminder => {
        const syncId = this.ensureReminderIdentity(reminder);
        stores['reminders'].put({ key: this.resourceKey(partition, syncId), partition, syncId, value: reminder });
      });
      attachments.forEach(attachment => {
        if (!attachment.syncId) return;
        stores['attachments'].put({
          key: this.resourceKey(partition, attachment.syncId),
          partition,
          syncId: attachment.syncId,
          value: attachment
        });
      });
      stores['syncState'].put({
        key: partition,
        partition,
        cursor,
        serverOffsetMs: Number(serverTime || Date.now()) - Date.now()
      } satisfies SyncState);
    });
  }

  async listNotes(partition: string) {
    const records = await this.listRecords<NoteI>('notes', partition);
    const byIdentity = new Map<string, NoteI>();
    for (const record of records) {
      const identity = record.value.id != null ? `id:${record.value.id}` : `sync:${record.syncId}`;
      const existing = byIdentity.get(identity);
      byIdentity.set(identity, existing ? this.preferNote(existing, record.value) : record.value);
    }
    if (byIdentity.size !== records.length) {
      const db = await this.open();
      await this.clearPartitionStore(db, 'notes', partition);
      await this.transaction(db, ['notes'], 'readwrite', stores => {
        byIdentity.forEach(note => {
          const syncId = this.ensureNoteIdentity(note);
          stores['notes'].put({ key: this.resourceKey(partition, syncId), partition, syncId, value: note });
        });
      });
    }
    return [...byIdentity.values()];
  }

  async listReminders(partition: string) {
    return this.listValues<ReminderI>('reminders', partition);
  }

  async getNote(partition: string, id: number) {
    const notes = await this.listNotes(partition);
    return notes.find(note => note.id === id);
  }

  async putNote(partition: string, note: NoteI) {
    const syncId = this.ensureNoteIdentity(note);
    const existing = note.id != null
      ? (await this.listRecords<NoteI>('notes', partition)).filter(record => record.value.id === note.id)
      : [];
    const preferred = existing.reduce<NoteI | undefined>((best, record) => {
      if (!best) return record.value;
      return this.preferNote(best, record.value);
    }, undefined);
    const value = preferred ? this.preferNote(preferred, note) : note;
    const db = await this.open();
    await this.transaction(db, ['notes'], 'readwrite', stores => {
      existing
        .filter(record => record.syncId !== syncId)
        .forEach(record => stores['notes'].delete(record.key));
      stores['notes'].put({ key: this.resourceKey(partition, syncId), partition, syncId, value });
    });
  }

  async overwriteNoteMetadata(partition: string, note: NoteI) {
    const syncId = this.ensureNoteIdentity(note);
    const existing = note.id != null
      ? (await this.listRecords<NoteI>('notes', partition)).filter(record => record.value.id === note.id)
      : [];
    const db = await this.open();
    await this.transaction(db, ['notes'], 'readwrite', stores => {
      existing
        .filter(record => record.syncId !== syncId)
        .forEach(record => stores['notes'].delete(record.key));
      stores['notes'].put({ key: this.resourceKey(partition, syncId), partition, syncId, value: note });
    });
  }

  async deleteNote(partition: string, syncId: string) {
    await this.deleteResource('notes', partition, syncId);
  }

  async putReminder(partition: string, reminder: ReminderI) {
    const syncId = this.ensureReminderIdentity(reminder);
    await this.putResource('reminders', partition, syncId, reminder);
  }

  async deleteReminder(partition: string, syncId: string) {
    await this.deleteResource('reminders', partition, syncId);
  }

  async putAttachment(partition: string, attachment: NoteAttachmentI) {
    if (!attachment.syncId) return;
    await this.putResource('attachments', partition, attachment.syncId, attachment);
  }

  async replaceSavedPlaces(partition: string, places: LocationSavedPlace[]) {
    const db = await this.open();
    await this.clearPartitionStore(db, 'savedPlaces', partition);
    await this.transaction(db, ['savedPlaces'], 'readwrite', stores => {
      places.forEach(place => stores['savedPlaces'].put({
        key: `${partition}|${place.id}`,
        partition,
        syncId: String(place.id),
        value: place
      }));
    });
  }

  async listSavedPlaces(partition: string) {
    return this.listValues<LocationSavedPlace>('savedPlaces', partition);
  }

  async deleteAttachment(partition: string, syncId: string) {
    await this.deleteResource('attachments', partition, syncId);
  }

  async enqueue(partition: string, type: SyncMutationType, syncId: string, payload: unknown, stamp: LwwStamp) {
    const entry: OutboxEntry = {
      key: `${partition}|${stamp.operationId}`,
      partition,
      operationId: stamp.operationId,
      type,
      syncId,
      payload,
      lww: stamp,
      createdAt: Date.now(),
      attempts: 0
    };
    const db = await this.open();
    await this.request(db.transaction('outbox', 'readwrite').objectStore('outbox').put(entry));
    return entry;
  }

  async listOutbox(partition: string) {
    const priority: Record<SyncMutationType, number> = {
      'note.upsert': 0,
      'note.delete': 1,
      'note.reorder': 2,
      'reminder.upsert': 3,
      'reminder.delete': 4,
      'attachment.upload': 5,
      'attachment.delete': 6
    };
    return (await this.listByPartition<OutboxEntry>('outbox', partition)).sort((left, right) =>
      left.createdAt - right.createdAt ||
      priority[left.type] - priority[right.type] ||
      left.operationId.localeCompare(right.operationId)
    );
  }

  async removeOutbox(keys: string[]) {
    if (!keys.length) return;
    const db = await this.open();
    await this.transaction(db, ['outbox'], 'readwrite', stores => {
      keys.forEach(key => stores['outbox'].delete(key));
    });
  }

  async cancelPendingAttachmentUpload(partition: string, syncId: string) {
    const entries = await this.listOutbox(partition);
    const matches = entries.filter(entry => entry.type === 'attachment.upload' && entry.syncId === syncId);
    for (const entry of matches) {
      const blobKey = (entry.payload as { blobKey?: string })?.blobKey;
      if (blobKey) await this.deleteBlob(partition, blobKey);
    }
    await this.removeOutbox(matches.map(entry => entry.key));
    return matches.length > 0;
  }

  async putBlob(partition: string, blobKey: string, blob: Blob) {
    const db = await this.open();
    await this.request(db.transaction('blobs', 'readwrite').objectStore('blobs').put({
      key: `${partition}|${blobKey}`,
      partition,
      blobKey,
      value: blob
    }));
  }

  async getBlob(partition: string, blobKey: string) {
    const db = await this.open();
    const record = await this.request<{ value: Blob } | undefined>(
      db.transaction('blobs').objectStore('blobs').get(`${partition}|${blobKey}`)
    );
    return record?.value;
  }

  async cacheMedia(partition: string, canonicalUrl: string, requestUrl: string) {
    if (!canonicalUrl || canonicalUrl.startsWith('data:') || canonicalUrl.startsWith('blob:')) return;
    try {
      const response = await fetch(requestUrl);
      if (!response.ok) return;
      await this.putBlob(partition, `media:${canonicalUrl}`, await response.blob());
    } catch {}
  }

  async offlineMediaUrl(partition: string, canonicalUrl: string) {
    const existing = this.offlineMediaObjectMap().get(`${partition}|${canonicalUrl}`);
    if (existing) return existing;
    const blob = await this.getBlob(partition, `media:${canonicalUrl}`);
    if (!blob) return canonicalUrl;
    const objectUrl = URL.createObjectURL(blob);
    this.offlineMediaCanonicalMap().set(objectUrl, canonicalUrl);
    this.offlineMediaObjectMap().set(`${partition}|${canonicalUrl}`, objectUrl);
    return objectUrl;
  }

  canonicalMediaUrl(value: string) {
    return this.offlineMediaCanonicalMap().get(value) || value;
  }

  async deleteBlob(partition: string, blobKey: string) {
    const db = await this.open();
    await this.request(db.transaction('blobs', 'readwrite').objectStore('blobs').delete(`${partition}|${blobKey}`));
  }

  async getSyncState(partition: string): Promise<SyncState> {
    const db = await this.open();
    return (await this.request<SyncState | undefined>(db.transaction('syncState').objectStore('syncState').get(partition))) || {
      key: partition,
      partition,
      cursor: 0,
      serverOffsetMs: 0
    };
  }

  async setSyncState(partition: string, cursor: number, serverTime?: number) {
    const current = await this.getSyncState(partition);
    const next: SyncState = {
      ...current,
      cursor,
      serverOffsetMs: serverTime ? serverTime - Date.now() : current.serverOffsetMs
    };
    const db = await this.open();
    await this.request(db.transaction('syncState', 'readwrite').objectStore('syncState').put(next));
  }

  async purgePartition(partition: string) {
    const db = await this.open();
    await Promise.all(
      ['notes', 'reminders', 'attachments', 'savedPlaces', 'outbox', 'blobs'].map(name => this.clearPartitionStore(db, name, partition))
    );
    await this.request(db.transaction('syncState', 'readwrite').objectStore('syncState').delete(partition));
  }

  private resourceKey(partition: string, syncId: string) {
    return `${partition}|${syncId}`;
  }

  private async putResource<T>(storeName: string, partition: string, syncId: string, value: T) {
    const db = await this.open();
    const record: StoredResource<T> = { key: this.resourceKey(partition, syncId), partition, syncId, value };
    await this.request(db.transaction(storeName, 'readwrite').objectStore(storeName).put(record));
  }

  private async deleteResource(storeName: string, partition: string, syncId: string) {
    const db = await this.open();
    await this.request(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(this.resourceKey(partition, syncId)));
  }

  private async listValues<T>(storeName: string, partition: string) {
    const records = await this.listRecords<T>(storeName, partition);
    return records.map(record => record.value);
  }

  private listRecords<T>(storeName: string, partition: string) {
    return this.listByPartition<StoredResource<T>>(storeName, partition);
  }

  private preferNote(left: NoteI, right: NoteI) {
    const leftStamp = Number(left.lwwPhysicalMs || Date.parse(left.updatedAt || '') || 0);
    const rightStamp = Number(right.lwwPhysicalMs || Date.parse(right.updatedAt || '') || 0);
    if (!!left.isCardPreview !== !!right.isCardPreview) {
      const full = left.isCardPreview ? right : left;
      const latest = rightStamp >= leftStamp ? right : left;
      return {
        ...latest,
        ...full,
        sortOrder: latest.sortOrder,
        pinned: latest.pinned,
        updatedAt: latest.updatedAt,
        lwwPhysicalMs: latest.lwwPhysicalMs,
        lwwLogical: latest.lwwLogical,
        lwwDeviceId: latest.lwwDeviceId,
        lwwOperationId: latest.lwwOperationId,
        isCardPreview: false
      };
    }
    if (rightStamp !== leftStamp) return rightStamp > leftStamp ? right : left;
    return { ...left, ...right };
  }

  private offlineMediaCanonicalMap(): Map<string, string> {
    const global = window as typeof window & { __keptOfflineMediaCanonical?: Map<string, string> };
    if (!global.__keptOfflineMediaCanonical) global.__keptOfflineMediaCanonical = new Map();
    return global.__keptOfflineMediaCanonical;
  }

  private offlineMediaObjectMap(): Map<string, string> {
    const global = window as typeof window & { __keptOfflineMediaObjects?: Map<string, string> };
    if (!global.__keptOfflineMediaObjects) global.__keptOfflineMediaObjects = new Map();
    return global.__keptOfflineMediaObjects;
  }

  private async listByPartition<T>(storeName: string, partition: string): Promise<T[]> {
    const db = await this.open();
    const index = db.transaction(storeName).objectStore(storeName).index('partition');
    return this.request<T[]>(index.getAll(IDBKeyRange.only(partition)));
  }

  private clearPartitionStore(db: IDBDatabase, storeName: string, partition: string) {
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.index('partition').openKeyCursor(IDBKeyRange.only(partition));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private async open() {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.databaseName, this.databaseVersion);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of ['notes', 'reminders', 'attachments', 'savedPlaces', 'outbox', 'blobs']) {
            if (!db.objectStoreNames.contains(name)) {
              const store = db.createObjectStore(name, { keyPath: 'key' });
              store.createIndex('partition', 'partition', { unique: false });
            }
          }
          if (!db.objectStoreNames.contains('syncState')) db.createObjectStore('syncState', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.database;
  }

  private request<T = unknown>(request: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private transaction(
    db: IDBDatabase,
    storeNames: string[],
    mode: IDBTransactionMode,
    work: (stores: Record<string, IDBObjectStore>) => void
  ) {
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeNames, mode);
      const stores = Object.fromEntries(storeNames.map(name => [name, transaction.objectStore(name)]));
      work(stores);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}
