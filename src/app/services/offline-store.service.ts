import { notePositionsForOrder, positionBetweenNotes } from '../../../shared/note-order';
import { uiText } from '../i18n/messages';
import { applyBinderMembership, applyPersonalOrganization, projectSharedOrganization } from '../utils/shared-note-organization';
import { Capacitor } from '@capacitor/core';
import { Injectable } from '@angular/core';
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import type { LocationSavedPlace } from './location-saved-places.service';
import { createUuid } from '../utils/uuid';
import { createDemoNotes, demoWelcomeText } from '../utils/demo-notes';
import { CatalogItem, MutationOutcome, NativeAction, ResourceChange, ResourceType, RESOURCE_STORES, Workspace } from '../interfaces/workspace';
import takeoutSourceFields from '../../../shared/takeout-source-fields.json';

const takeoutSourceFieldSet = new Set<string>(takeoutSourceFields);
const cleanNoteMetadata = (note: Record<string, any>) => Object.fromEntries(
  Object.entries(note).filter(([key]) => !takeoutSourceFieldSet.has(key))
);

export type SyncResourceType = ResourceType;
export type SyncMutationType =
  | 'image.upload'
  | 'note.binder'
  | 'note.organization'
  | 'note.upsert'
  | 'note.delete'
  | 'note.reorder'
  | 'reminder.upsert'
  | 'reminder.occurrence'
  | 'reminder.delete'
  | 'attachment.upload'
  | 'attachment.upsert'
  | 'attachment.delete'
  | 'label.upsert' | 'label.delete' | 'binder.upsert' | 'binder.delete'
  | 'savedPlace.upsert' | 'savedPlace.delete' | 'preferences.patch';

type MutationOptions = { blobs?: Array<{ key: string; value: Blob }>; attachments?: Record<string,any>[]; action?: NativeAction };

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
  blockedBy?: 'storage';
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
  private readonly databaseVersion = 4;
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
      value = createUuid();
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
      operationId: createUuid()
    };
  }

  ensureNoteIdentity(note: NoteI) {
    if (!note.syncId) note.syncId = `note-${createUuid()}`;
    return note.syncId;
  }

  ensureReminderIdentity(reminder: Partial<ReminderI>) {
    if (!reminder.syncId) reminder.syncId = `reminder-${createUuid()}`;
    return reminder.syncId;
  }

  async replaceSnapshot(partition: string, notes: NoteI[], reminders: ReminderI[], attachments: NoteAttachmentI[], cursor: number, serverTime: number) {
    const workspace = await this.ensureServerWorkspace(partition);
    await this.reconcile(workspace, { snapshot: {
      note: notes, reminder: reminders, attachment: attachments
    }, cursor, serverTime });
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
      await this.transaction(db, ['notes'], 'readwrite', stores => {
        records.forEach(record => stores['notes'].delete(record.key));
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

  async hasNotes(partition: string) {
    const db = await this.open();
    return (await this.request<IDBValidKey | undefined>(db.transaction('notes').objectStore('notes').index('partition').getKey(partition))) !== undefined;
  }

  async getNote(partition: string, id: number) {
    const db = await this.open();
    const rows = await this.request<StoredResource<NoteI>[]>(db.transaction('notes').objectStore('notes').index('partitionId').getAll([partition,id]));
    return rows.reduce<NoteI | undefined>((best,row) => best ? this.preferNote(best,row.value) : row.value, undefined);
  }

  async getNotesBySyncIds(partition: string, syncIds: string[]) {
    const db = await this.open(), store = db.transaction('notes').objectStore('notes');
    const rows = await Promise.all([...new Set(syncIds)].map(syncId =>
      this.request<StoredResource<NoteI> | undefined>(store.get(this.resourceKey(partition,syncId)))));
    return rows.filter((row): row is StoredResource<NoteI> => !!row).map(row => row.value);
  }

  async getNoteBySyncId(partition: string, syncId: string): Promise<NoteI | undefined> {
    return (await this.getNotesBySyncIds(partition,[syncId]))[0];
  }

  async putNotePositions(partition: string, positions: Array<{ id: number; sortOrder: number }>) {
    return this.atomic(['notes'], async tx => {
      const store = tx.objectStore('notes');
      const rows = await Promise.all(positions.map(position => this.request<StoredResource<NoteI> | undefined>(store.index('partitionId').get([partition,position.id]))));
      rows.forEach((row, index) => {
        if (row && row.value.sortOrder !== positions[index].sortOrder) store.put({ ...row, value: { ...row.value, sortOrder: positions[index].sortOrder } });
      });
    });
  }

  async missingNotePositions(partition: string, positions: Array<{ syncId: string; id: number }>) {
    const db = await this.open();
    const tx = db.transaction('notes', 'readonly');
    const rows = await Promise.all(positions.map(position => this.request<IDBValidKey | undefined>(
      tx.objectStore('notes').getKey(this.resourceKey(partition, position.syncId)))));
    return positions.filter((_, index) => !rows[index]);
  }

  async putNote(partition: string, note: NoteI) {
    const syncId = this.ensureNoteIdentity(note);
    await this.atomic(['notes'], async tx => {
      const store = tx.objectStore('notes');
      const existing = note.id != null ? await this.request<StoredResource<NoteI>[]>(store.index('partitionId').getAll([partition,note.id])) : [];
      const preferred = existing.reduce<NoteI | undefined>((best,row) => best ? this.preferNote(best,row.value) : row.value, undefined);
      const value = preferred ? this.preferNote(preferred,note) : note;
      existing.filter(record => record.syncId !== syncId).forEach(record => store.delete(record.key));
      store.put({ key:this.resourceKey(partition,syncId),partition,syncId,value });
    });
  }

  async overwriteNoteMetadata(partition: string, note: NoteI) {
    const syncId = this.ensureNoteIdentity(note);
    await this.atomic(['notes'], async tx => {
      const store = tx.objectStore('notes');
      const existing = note.id != null ? await this.request<StoredResource<NoteI>[]>(store.index('partitionId').getAll([partition,note.id])) : [];
      existing.filter(record => record.syncId !== syncId).forEach(record => store.delete(record.key));
      store.put({ key:this.resourceKey(partition,syncId),partition,syncId,value:note });
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
    await this.atomic(['savedPlaces'], async tx => {
      const store = tx.objectStore('savedPlaces');
      const old = await this.request<StoredResource<any>[]>(store.index('partition').getAll(partition));
      old.forEach(row => store.delete(row.key));
      for (const place of places) {
        const syncId = (place as any).syncId || String(place.id);
        store.put({ key: this.resourceKey(partition, syncId), partition, syncId, value: place });
      }
    });
  }

  async listSavedPlaces(partition: string) {
    return this.listValues<LocationSavedPlace>('savedPlaces', partition);
  }

  async deleteAttachment(partition: string, syncId: string) {
    await this.deleteResource('attachments', partition, syncId);
  }

  async enqueue(partition: string, type: SyncMutationType, syncId: string, payload: unknown, stamp: LwwStamp) {
    if (type === 'note.upsert' && (payload as NoteI)?.sharedOrganization) {
      const { sharedOrganization, labels, binder, ...content } = payload as NoteI;
      payload = content;
    }
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
    await this.transaction(db, ['outbox'], 'readwrite', stores => { stores['outbox'].put(entry); });
    return entry;
  }

  async listOutbox(partition: string) {
    const priority: Record<SyncMutationType, number> = {
      'image.upload': -10,
      'note.upsert': 0, 'note.organization': 0, 'note.binder': 0,
      'note.delete': 1,
      'note.reorder': 2,
      'reminder.upsert': 3, 'reminder.occurrence': 4,
      'reminder.delete': 4,
      'attachment.upload': 5, 'attachment.upsert': 5,
      'attachment.delete': 6,
      'label.upsert': -3, 'label.delete': 7, 'binder.upsert': -2, 'binder.delete': 8,
      'savedPlace.upsert': -1, 'savedPlace.delete': 9, 'preferences.patch': 10
    };
    return (await this.listByPartition<OutboxEntry>('outbox', partition)).sort((left, right) =>
      left.createdAt - right.createdAt ||
      priority[left.type] - priority[right.type] ||
      (left.type === 'note.reorder' && right.type === 'note.reorder' ? (left.lww.logical || 0) - (right.lww.logical || 0) : 0) ||
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

  async markUploadStorageBlocked(workspace: Workspace, entry: OutboxEntry) {
    return this.atomic(['outbox', 'workspaces'], async tx => {
      const meta = await this.request<Workspace | undefined>(tx.objectStore('workspaces').get(workspace.id));
      if (!meta || meta.generation !== workspace.generation || meta.status !== 'active') throw new Error('Obsolete upload response.');
      const current = await this.request<OutboxEntry | undefined>(tx.objectStore('outbox').get(entry.key));
      if (!current) return false; // The person may have deleted it during upload.
      tx.objectStore('outbox').put({ ...current, blockedBy: 'storage', attempts: current.attempts + 1 });
      return true;
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
    await this.transaction(db, ['blobs'], 'readwrite', stores => {
      stores['blobs'].put({ key: `${partition}|${blobKey}`, partition, blobKey, value: blob });
    });
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
      const response = await fetch(requestUrl, { credentials: Capacitor.isNativePlatform() ? 'same-origin' : 'include' });
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
    await this.transaction(db, ['blobs'], 'readwrite', stores => { stores['blobs'].delete(`${partition}|${blobKey}`); });
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
    await this.transaction(db, ['syncState'], 'readwrite', stores => { stores['syncState'].put(next); });
  }

  async purgePartition(partition: string) {
    if (partition.startsWith('local:')) throw new Error('Local workspaces cannot be purged by account cleanup.');
    const db = await this.open();
    await Promise.all(
      ['notes', 'reminders', 'attachments', 'savedPlaces', 'outbox', 'blobs', 'labels', 'binders', 'preferences', 'baseline', 'receipts', 'conflicts', 'snapshotRows'].map(name => this.clearPartitionStore(db, name, partition))
    );
    await this.request(db.transaction('syncState', 'readwrite').objectStore('syncState').delete(partition));
  }

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    const db = await this.open();
    return this.request<Workspace | undefined>(db.transaction('workspaces').objectStore('workspaces').get(id));
  }

  async listWorkspaces() {
    const db = await this.open();
    return this.request<Workspace[]>(db.transaction('workspaces').objectStore('workspaces').getAll());
  }

  async saveWorkspace(value: Workspace) {
    const db = await this.open();
    await this.transaction(db, ['workspaces'], 'readwrite', stores => { stores['workspaces'].put(value); });
  }

  async patchWorkspace(id: string, patch: Partial<Workspace> | ((workspace:Workspace)=>Partial<Workspace>)) {
    return this.atomic(['workspaces'], async tx => {
      const store = tx.objectStore('workspaces');
      const previous = await this.request<Workspace | undefined>(store.get(id));
      if (!previous) throw new Error('Workspace not found.');
      const value = { ...previous, ...(typeof patch === 'function' ? patch(previous) : patch), id: previous.id, partition: previous.partition, updatedAt: new Date().toISOString() };
      store.put(value);
      return value;
    });
  }

  /** Seed a new device library and its marker together, including sample media. */
  async seedLocalDemoNotes(workspace: Workspace) {
    return this.atomic(['workspaces', 'notes', 'labels', 'attachments', 'blobs'], async tx => {
      const metadata = tx.objectStore('workspaces');
      const current = await this.request<Workspace | undefined>(metadata.get(workspace.id));
      if (!current || current.mode !== 'local' || current.status !== 'active' ||
          current.generation !== workspace.generation || current.demoNotesSeeded !== false) return;
      const notes = tx.objectStore('notes');
      const existing = await this.request<number>(notes.index('partition').count(current.partition));
      const now = new Date().toISOString();
      // Never add starter content to an existing, restored or imported library.
      if (current.revision === 0 && existing === 0) {
        const label = { id: current.nextId++, syncId: `label-${createUuid()}`, name: 'Sweet Thoughts', updatedAt: now };
        tx.objectStore('labels').put({ key: this.resourceKey(current.partition, label.syncId), partition: current.partition, syncId: label.syncId, value: label });
        const demos = createDemoNotes(label);
        for (const [index, demo] of demos.entries()) {
          const syncId = `note-${createUuid()}`;
          const value = { ...demo, id: current.nextId++, syncId, createdAt: now, updatedAt: now, sortOrder: Date.now() + index };
          notes.put({ key: this.resourceKey(current.partition, syncId), partition: current.partition, syncId, value });
          if (index === demos.length - 1) {
            const attachmentSyncId = `attachment-${createUuid()}`;
            const file = new Blob([demoWelcomeText], { type: 'text/plain' });
            const attachment = { id: current.nextId++, syncId: attachmentSyncId, noteId: value.id,
              noteSyncId: syncId, originalName: 'welcome.txt', fileSize: file.size, mimeType: file.type, uploadedAt: now };
            tx.objectStore('attachments').put({ key: this.resourceKey(current.partition, attachmentSyncId), partition: current.partition, syncId: attachmentSyncId, value: attachment });
            tx.objectStore('blobs').put({ key: `${current.partition}|attachment:${attachmentSyncId}`, partition: current.partition, blobKey: `attachment:${attachmentSyncId}`, value: file });
          }
        }
        // The reminder demo stays instructional: setup must not request permission.
        current.revision++;
      }
      current.demoNotesSeeded = true;
      current.updatedAt = now;
      metadata.put(current);
      return current;
    });
  }

  async ensureServerWorkspace(partition: string) {
    return this.atomic(['workspaces'], async tx => {
      const store = tx.objectStore('workspaces');
      let value = await this.request<Workspace | undefined>(store.get(partition));
      if (!value) {
        const now = new Date().toISOString();
        value = {
          id: partition, partition, mode: 'server', generation: createUuid(), status: 'active',
          createdAt: now, updatedAt: now, nextId: Date.now(), revision: 0,
          preferences: { theme: 'light', followSystemTheme: true, showPastReminders: false }
        };
        store.put(value);
      }
      return value;
    });
  }

  async listResources<T>(type: ResourceType, partition: string): Promise<T[]> {
    return this.listValues<T>(RESOURCE_STORES[type], partition);
  }

  async nativeProjection(workspace: Workspace) {
    return this.atomic(['notes','workspaces'],async tx => {
      const current = await this.request<Workspace>(tx.objectStore('workspaces').get(workspace.id));
      if (!current || current.generation !== workspace.generation || current.status !== 'active') throw new Error('The workspace is not active.');
      const rows = await this.request<StoredResource<NoteI>[]>(tx.objectStore('notes').index('partition').getAll(workspace.partition));
      return {workspace:current,notes:rows.map(row=>row.value)};
    });
  }

  async listConflicts(partition: string) { return this.listByPartition<any>('conflicts', partition); }

  async resolveConflict(partition:string,key:string) {
    const db = await this.open();
    await this.transaction(db,['conflicts'],'readwrite',stores=>{if(key.startsWith(`${partition}|`)) stores['conflicts'].delete(key);});
  }

  async recordConflict(partition: string, identity: string, value: unknown, reason: string) {
    const db = await this.open();
    await this.transaction(db, ['conflicts'], 'readwrite', stores => {
      stores['conflicts'].put({ key: `${partition}|${identity}`, partition, value, reason, createdAt: Date.now() });
    });
  }

  async hasReceipt(partition: string, actionId: string) {
    const db = await this.open();
    return !!await this.request(db.transaction('receipts').objectStore('receipts').get(`${partition}|${actionId}`));
  }

  /** Copy immutable backup rows under the same transaction as the source read. */
  async captureBackup(workspace: Workspace) {
    const id = createUuid();
    const names = [...Object.values(RESOURCE_STORES), 'blobs'];
    return this.atomic([...names, 'snapshotRows', 'workspaces'], async tx => {
      const current = await this.request<Workspace | undefined>(tx.objectStore('workspaces').get(workspace.id));
      if (!current || current.generation !== workspace.generation) throw new Error('Workspace changed before the backup started.');
      const snapshot = { ...current, id, partition: `backup:${id}`, status: 'staging' as const };
      tx.objectStore('workspaces').put(snapshot);
      const referenced = new Set<string>();
      for (const name of names) await new Promise<void>((resolve, reject) => {
        const request = tx.objectStore(name).index('partition').openCursor(workspace.partition);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(); return; }
          const row = cursor.value;
          if (name === 'notes') {
            for (const image of row.value.images || []) if (image.dataUrl && !image.dataUrl.startsWith('data:')) referenced.add(`media:${image.dataUrl}`);
            for (const match of String(row.value.noteBody || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) referenced.add(`media:${match[1]}`);
          }
          if (name === 'attachments') referenced.add(`attachment:${row.syncId}`);
          if (name !== 'blobs' || referenced.has(row.blobKey)) tx.objectStore('snapshotRows').put({ key: `${id}|${name}|${cursor.primaryKey}`, partition: id, store: name, record: row });
          cursor.continue();
        };
      });
      return snapshot;
    });
  }

  async resourcePage(type: ResourceType, partition: string, after?: string): Promise<{key:string;value:any} | undefined> {
    const db = await this.open();
    const request = db.transaction(RESOURCE_STORES[type]).objectStore(RESOURCE_STORES[type]).openCursor(IDBKeyRange.bound(after || `${partition}|`,`${partition}|\uffff`,!!after));
    const cursor = await this.request<IDBCursorWithValue | null>(request);
    return cursor?.value;
  }

  async snapshotPage(id: string, after?: string, limit = 1): Promise<Array<{ key: string; store: string; record: any }>> {
    const db = await this.open();
    const store = db.transaction('snapshotRows').objectStore('snapshotRows');
    return new Promise((resolve, reject) => {
      const rows: Array<{ key: string; store: string; record: any }> = [];
      const range = IDBKeyRange.bound(after || `${id}|`, `${id}|\uffff`, !!after);
      const request = store.openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= limit) { resolve(rows); return; }
        rows.push(cursor.value); cursor.continue();
      };
    });
  }

  async discardStaging(id: string) {
    const value = await this.getWorkspace(id);
    if (!value || value.status !== 'staging') throw new Error('Only an inactive staging workspace can be discarded.');
    await this.atomic([...Object.values(RESOURCE_STORES), 'blobs', 'snapshotRows', 'workspaces'], async tx => {
      for (const name of [...Object.values(RESOURCE_STORES), 'blobs', 'snapshotRows']) {
        await new Promise<void>((resolve, reject) => {
          const request = tx.objectStore(name).index('partition').openCursor(name === 'snapshotRows' ? id : value.partition);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => { const cursor = request.result; if (!cursor) return resolve(); cursor.delete(); cursor.continue(); };
        });
      }
      tx.objectStore('workspaces').delete(id);
    });
  }

  async stageRecord(workspace: Workspace, type: ResourceType, value: Record<string, any>) {
    await this.atomic([RESOURCE_STORES[type], 'workspaces'], async tx => {
      const meta = await this.request<Workspace>(tx.objectStore('workspaces').get(workspace.id));
      if (meta.status !== 'staging') throw new Error('Restore workspace is already active.');
      const key = this.resourceKey(workspace.partition, value['syncId']);
      if (await this.request(tx.objectStore(RESOURCE_STORES[type]).get(key))) throw new Error('The backup contains duplicate record identities.');
      tx.objectStore(RESOURCE_STORES[type]).put({ key, partition: workspace.partition, syncId: value['syncId'], value });
      meta.nextId = Math.max(meta.nextId, Number(value['id'] || 0) + 1);
      tx.objectStore('workspaces').put(meta);
    });
  }

  /** User-visible projection, outgoing operation and native replay receipt share one commit. */
  async commitMutation<T extends Record<string, any>>(
    workspace: Workspace, type: SyncMutationType, syncId: string, input: T,
    options: MutationOptions = {}
  ): Promise<T> {
    const stamp = this.nextStamp((await this.getSyncState(workspace.partition)).serverOffsetMs);
    return this.atomic([...Object.values(RESOURCE_STORES), 'outbox', 'blobs', 'workspaces', 'receipts', 'conflicts'],
      tx => this.applyMutation(tx, workspace, type, syncId, input, options, stamp));
  }

  async trashNotes(workspace: Workspace, syncIds: string[], userId?: number) {
    const offset = (await this.getSyncState(workspace.partition)).serverOffsetMs;
    return this.atomic([...Object.values(RESOURCE_STORES), 'outbox', 'blobs', 'workspaces', 'receipts', 'conflicts'], async tx => {
      const affected: NoteI[] = [];
      let leftSharedCount = 0;
      for (const syncId of new Set(syncIds)) {
        // Read inside the transaction so edits queued just before this action survive.
        const row = await this.request<StoredResource<NoteI> | undefined>(tx.objectStore('notes').get(this.resourceKey(workspace.partition, syncId)));
        if (!row) throw new Error(uiText('notes.this_note_is_unavailable_on_this_device'));
        const note = row.value;
        const leaveShared = !!(note.ownerUserId && userId && note.ownerUserId !== userId && !note.sharedBinder);
        await this.applyMutation(tx, workspace, leaveShared ? 'note.delete' : 'note.upsert', syncId,
          leaveShared ? note : { ...note, trashed: true, archived: false }, {}, this.nextStamp(offset));
        affected.push({ ...note, trashed: true, archived: false });
        if (leaveShared) leftSharedCount++;
      }
      return { affected, leftSharedCount };
    });
  }

  private async applyMutation<T extends Record<string, any>>(
    tx: IDBTransaction, workspace: Workspace, type: SyncMutationType, syncId: string, input: T, options: MutationOptions, stamp: LwwStamp
  ): Promise<T> {
      const partition = workspace.partition;
      const meta = await this.request<Workspace | undefined>(tx.objectStore('workspaces').get(workspace.id));
      if (!meta || meta.generation !== workspace.generation || meta.status !== 'active') {
        throw new Error('This workspace changed or is paused for a transfer. Your edit was not committed.');
      }
      const action = options.action;
      if (action) {
        if (action.workspaceId !== meta.id || action.generation !== meta.generation) throw new Error('Native action belongs to another workspace generation.');
        const replay = await this.request<any>(tx.objectStore('receipts').get(`${partition}|${action.actionId}`));
        if (replay) return replay.result as T;
      }
      const payload: Record<string, any> = { ...(type.startsWith('note.') ? cleanNoteMetadata(input) : input), syncId };
      const resource = type.split('.')[0] as ResourceType;
      if (resource === 'note') {
        for (const [source, target] of Object.entries((meta as any).mediaAliases || {}) as [string,string][]) {
          if (typeof payload['noteBody'] === 'string') payload['noteBody'] = payload['noteBody'].split(source).join(target);
          if (Array.isArray(payload['images'])) payload['images'] = payload['images'].map((image:any)=>({...image,dataUrl:image.dataUrl === source ? target : image.dataUrl}));
        }
      }
      if (type.endsWith('.upsert') && payload['id'] == null) {
        payload['id'] = meta.mode === 'local' ? meta.nextId++ : -(++meta.nextId);
      }
      payload['updatedAt'] = new Date().toISOString();
      payload['createdAt'] ||= payload['updatedAt'];
      Object.assign(payload, { lwwPhysicalMs: stamp.physicalMs, lwwLogical: stamp.logical, lwwDeviceId: stamp.deviceId, lwwOperationId: stamp.operationId });
      if (options.blobs) for (const blob of options.blobs) {
        tx.objectStore('blobs').put({ key: `${partition}|${blob.key}`, partition, blobKey: blob.key, value: blob.value });
      }
      if (type === 'note.binder') {
        const key=this.resourceKey(partition,syncId);
        const previous=await this.request<StoredResource<NoteI> | undefined>(tx.objectStore('notes').get(key));
        if (!previous) throw new Error('This shared note is unavailable on this device.');
        for (const key of Object.keys(payload)) if (!['syncId','binderId','binderName','binder','sharedBinder'].includes(key)) delete payload[key];
        tx.objectStore('notes').put({...previous,value:applyBinderMembership(previous.value,payload)});
      } else if (type === 'note.organization') {
        const key = this.resourceKey(partition, syncId);
        const previous = await this.request<StoredResource<NoteI> | undefined>(tx.objectStore('notes').get(key));
        if (!previous?.value.sharedOrganization) throw new Error('This shared note is unavailable on this device.');
        // Keep a field-only outgoing operation; it must never replay stale note content.
        for (const key of Object.keys(payload)) if (!['syncId','labels','binder'].includes(key)) delete payload[key];
        tx.objectStore('notes').put({ ...previous, value: applyPersonalOrganization(previous.value, payload) });
      } else if (type === 'note.reorder') {
        const order = [...new Set(input['syncIds'] as string[])];
        const notes = tx.objectStore('notes');
        const movedIndex = order.indexOf(input['movedSyncId']);
        // The drag UI already knows the moved note. Read just it and its two
        // neighbours, rather than deserializing hundreds of imported bodies.
        let positions: Array<{id:number;syncId:string;sortOrder:number}> | undefined;
        let rows: Array<StoredResource<any> | undefined> = [];
        if (movedIndex >= 0) {
          const neighbours = [order[movedIndex],order[movedIndex-1],order[movedIndex+1]];
          rows = await Promise.all(neighbours.map(id => id ? this.request<StoredResource<any> | undefined>(notes.get(this.resourceKey(partition,id))) : undefined));
          const [moved,above,below] = rows;
          if (moved && neighbours.every((id,index) => !id || rows[index])) {
            const sameGroup = (row: StoredResource<any> | undefined) => row && !!row.value.pinned === !!moved.value.pinned ? row.value : undefined;
            const position = positionBetweenNotes(moved.value,sameGroup(above),sameGroup(below),stamp.physicalMs);
            if (position) positions = [position];
          }
        }
        if (!positions) {
          rows = await Promise.all(order.map(id => this.request<StoredResource<any> | undefined>(notes.get(this.resourceKey(partition,id)))));
          positions = notePositionsForOrder(rows.filter((row): row is StoredResource<any> => !!row).map(row => row.value), stamp.physicalMs);
        }
        payload['positions'] = positions;
        const bySyncId = new Map(rows.filter((row): row is StoredResource<any> => !!row).map(row => [row.syncId,row]));
        for (const position of positions) {
          const row = bySyncId.get(position.syncId)!;
          notes.put({...row,value:{...row.value,sortOrder:position.sortOrder}});
        }
      } else if (type !== 'image.upload') {
        const store = tx.objectStore(RESOURCE_STORES[resource]);
        const key = this.resourceKey(partition, syncId);
        const previous = await this.request<StoredResource<any> | undefined>(store.get(key));
        if (type === 'note.upsert' && !previous && payload['bgColor'] === undefined) payload['bgColor'] = meta.preferences.defaultNoteColor || '';
        if (type === 'note.upsert' && !previous && payload['sortOrder'] == null) {
          const notes = await this.request<StoredResource<NoteI>[]>(store.index('partition').getAll(partition));
          payload['sortOrder'] = notes.reduce((highest, note) => Math.max(highest, Number(note.value.sortOrder) || 0), stamp.physicalMs) + 1;
        }
        if (action && previous) {
          if (action.kind === 'checklist.set') {
            const box = previous.value.checkBoxes?.find((box:any)=>box.id === action.payload['checkboxId']);
            if (!box || typeof action.payload['done'] !== 'boolean') throw new Error('The queued checklist structure changed.');
            Object.assign(payload,previous.value,{checkBoxes:previous.value.checkBoxes.map((box:any)=>box.id === action.payload['checkboxId'] ? {...box,done:action.payload['done']} : box)});
          } else if (resource === 'note' && action.baseRevision !== meta.revision) {
            throw new Error('The note changed after the native snapshot.');
          } else if (resource === 'reminder' && !type.endsWith('.delete')) {
            const current = previous.value;
            const merged = {...current};
            const incoming = (action.payload['changes'] || action.payload) as Record<string,any>;
            for (const field of ['title','body','dueAtUtc','timezone','repeatRule','status','managedExternally','externalRepeatRule']) {
              if (incoming[field] === undefined) continue;
              const base = action.payload['base'] as Record<string,any> | undefined;
              if (base && JSON.stringify(current[field]) !== JSON.stringify(base[field])) {
                tx.objectStore('conflicts').put({key:`${partition}|${action.actionId}:${field}`,partition,value:action,reason:'The Kept reminder field changed since the native projection.'});
              } else merged[field] = incoming[field];
            }
            if (action.kind === 'reminder.upsert' && ['dueAtUtc','timezone','repeatRule'].some(field=>JSON.stringify(merged[field]) !== JSON.stringify(current[field]))) {
              merged.scheduleVersion = Number(current.scheduleVersion || 1)+1;
              merged.scheduleAnchorAtUtc = merged.dueAtUtc;
            }
            if (action.kind === 'reminder.occurrence') {
              if (Number(current.scheduleVersion || 1) !== Number(action.payload['scheduleVersion'])) throw new Error('The reminder schedule changed.');
              const due = action.payload['dueAtUtc'];
              if (current.lastOccurrenceId !== action.payload['occurrenceId'] && (!due || Date.parse(String(due)) >= Date.parse(current.dueAtUtc || ''))) {
                merged.status = action.payload['nextDueAtUtc'] ? 'pending' : 'fired';
                if (action.payload['nextDueAtUtc']) merged.dueAtUtc = action.payload['nextDueAtUtc'];
                merged.lastOccurrenceId = action.payload['occurrenceId'];
              }
            }
            Object.assign(payload,merged);
          } else if (resource === 'reminder' && type.endsWith('.delete') && action.baseRevision !== undefined && action.baseRevision !== meta.revision) {
            throw new Error('The reminder changed after the external deletion snapshot.');
          }
        }
        if (action) { payload['updatedAt'] = new Date().toISOString(); Object.assign(payload,{lwwPhysicalMs:stamp.physicalMs,lwwLogical:stamp.logical,lwwDeviceId:stamp.deviceId,lwwOperationId:stamp.operationId}); }
        if (type.endsWith('.delete')) {
          store.delete(key);
          if (resource === 'attachment') {
            const queued = await this.request<OutboxEntry[]>(tx.objectStore('outbox').index('partition').getAll(partition));
            for (const entry of queued) if (entry.syncId === syncId && entry.type.startsWith('attachment.')) tx.objectStore('outbox').delete(entry.key);
            tx.objectStore('blobs').delete(`${partition}|attachment:${syncId}`);
          }
          if (resource === 'note') {
            for (const related of ['reminders', 'attachments']) {
              const rows = await this.request<StoredResource<any>[]>(tx.objectStore(related).index('partition').getAll(partition));
              for (const row of rows) if ((previous && row.value.noteId === previous.value.id) || row.value.noteSyncId === syncId) {
                tx.objectStore(related).delete(row.key);
                if (related === 'attachments') tx.objectStore('blobs').delete(`${partition}|attachment:${row.syncId}`);
              }
            }
            const queued = await this.request<OutboxEntry[]>(tx.objectStore('outbox').index('partition').getAll(partition));
            for (const entry of queued) {
              const value = entry.payload as any;
              if ((entry.type.startsWith('note.') && entry.syncId === syncId) || value.noteSyncId === syncId || (previous && value.noteId === previous.value.id)) tx.objectStore('outbox').delete(entry.key);
            }
          }
        } else {
          const value = { ...previous?.value, ...payload };
          if (previous?.value.id != null) value.id = previous.value.id;
          Object.assign(payload, value);
          store.put({ key, partition, syncId, value });
          if (resource === 'preferences') {
            meta.preferences = { ...meta.preferences, ...input };
            const notes = await this.request<StoredResource<NoteI>[]>(tx.objectStore('notes').index('partition').getAll(partition));
            for (const note of notes) tx.objectStore('notes').put({ ...note, value: projectSharedOrganization(note.value, meta.preferences) });
          }
        }
        if (resource === 'attachment' && payload['noteId'] != null) {
          const notes = await this.request<StoredResource<any>[]>(tx.objectStore('notes').index('partition').getAll(partition));
          const note = notes.find(row => row.value.id === payload['noteId']);
          if (note) {
            note.value.attachments = (note.value.attachments || []).filter((item: any) => item.syncId !== syncId);
            if (!type.endsWith('.delete')) note.value.attachments.push(payload);
            tx.objectStore('notes').put(note);
          }
        }
        if (resource === 'label' || resource === 'binder') {
          const matchesLabel = (label: any) => label.syncId === syncId || (previous?.value.id != null && label.id === previous.value.id);
          const queued = await this.request<OutboxEntry[]>(tx.objectStore('outbox').index('partition').getAll(partition));
          for (const entry of queued.filter(entry=>entry.type === 'note.upsert' || entry.type === 'note.organization')) {
            const value = entry.payload as any;
            const before = JSON.stringify(value);
            if (resource === 'label' && Array.isArray(value.labels)) value.labels = (value.labels || []).flatMap((label:any)=>matchesLabel(label)
              ? type.endsWith('.delete') ? [] : [{...label,...payload}] : [label]);
            else if (resource === 'binder' && previous && value.binder === previous.value.name) value.binder = type.endsWith('.delete') ? '' : payload['name'];
            if (JSON.stringify(value) === before) continue;
            // Preserve any operation already sent: changed content receives a new
            // replay identity, while its replacement remains in this transaction.
            const operationId = `${stamp.operationId}:note:${queued.indexOf(entry)}`;
            tx.objectStore('outbox').delete(entry.key);
            tx.objectStore('outbox').put({...entry,key:`${partition}|${operationId}`,operationId,payload:value,lww:{...stamp,operationId}});
          }
          const notes = await this.request<StoredResource<any>[]>(tx.objectStore('notes').index('partition').getAll(partition));
          for (const note of notes) {
            if (note.value.sharedOrganization) {
              const org = note.value.sharedOrganization;
              if (resource === 'label') org.personalLabels = (org.personalLabels || []).flatMap((label:any) =>
                matchesLabel(label)
                  ? type.endsWith('.delete') ? [] : [{...label,...payload}] : [label]);
              else if (previous && org.personalBinder === previous.value.name) org.personalBinder = type.endsWith('.delete') ? '' : payload['name'];
            }
            if (resource === 'label') note.value.labels = (note.value.labels || []).flatMap((label: any) =>
              matchesLabel(label)
                ? type.endsWith('.delete') ? [] : [{ ...label, ...payload }] : [label]);
            else if (previous && note.value.binder === previous.value.name) note.value.binder = type.endsWith('.delete') ? '' : payload['name'];
            tx.objectStore('notes').put(note);
          }
        }
      }
      if (resource === 'note' && options.attachments?.length) {
        for (const [index, file] of options.attachments.entries()) {
          const id = meta.mode === 'local' ? meta.nextId++ : -(++meta.nextId);
          const value = {...file,id,noteId:payload['id'],noteSyncId:syncId};
          tx.objectStore('attachments').put({key:this.resourceKey(partition,file['syncId']),partition,syncId:file['syncId'],value});
          payload['attachments'] = [...(payload['attachments'] || []),value];
          if (meta.mode === 'server') {
            const operationId = `${stamp.operationId}:file:${index}`;
            tx.objectStore('outbox').put({key:`${partition}|${operationId}`,partition,operationId,type:'attachment.upsert',syncId:file['syncId'],payload:value,
              lww:{...stamp,operationId,logical:stamp.logical+index+1},createdAt:stamp.physicalMs,attempts:0});
          }
        }
        tx.objectStore('notes').put({key:this.resourceKey(partition,syncId),partition,syncId,value:payload});
      }
      if (meta.mode === 'server' && resource === 'note') for (const [index,blob] of (options.blobs || []).entries()) {
        if (!blob.key.startsWith('media:/__kept_local_media/')) continue;
        const operationId = `${stamp.operationId}:image:${index}`;
        tx.objectStore('outbox').put({key:`${partition}|${operationId}`,partition,operationId,type:'image.upload',syncId:operationId,
          payload:{url:blob.key.slice(6),filename:`capture.${blob.value.type.split('/')[1] || 'png'}`},lww:{...stamp,operationId},createdAt:stamp.physicalMs,attempts:0});
      }
      if (type === 'reminder.occurrence' && action) Object.assign(payload,{
        occurrenceId:action.payload['occurrenceId'],occurrenceDueAtUtc:action.payload['dueAtUtc'],nextDueAtUtc:action.payload['nextDueAtUtc'],scheduleVersion:action.payload['scheduleVersion']
      });
      let outgoingPayload = payload;
      if (type === 'note.upsert' && payload['sharedOrganization']) {
        const { sharedOrganization, labels, binder, ...content } = payload;
        outgoingPayload = content;
      }
      if (meta.mode === 'server') tx.objectStore('outbox').put({
        key: `${partition}|${stamp.operationId}`, partition, type, syncId, payload: outgoingPayload, lww: stamp,
        operationId: stamp.operationId, createdAt: stamp.physicalMs, attempts: 0
      } satisfies OutboxEntry);
      meta.revision++;
      meta.updatedAt = new Date().toISOString();
      tx.objectStore('workspaces').put(meta);
      if (action) tx.objectStore('receipts').put({ key: `${partition}|${action.actionId}`, partition, actionId: action.actionId, result: payload, revision: meta.revision });
      return payload as T;
  }

  async prepareQueuedImage(workspace: Workspace, entry: OutboxEntry, blob: Blob, filename: string) {
    return this.atomic(['outbox','blobs','workspaces'], async tx => {
      const meta = await this.request<Workspace>(tx.objectStore('workspaces').get(workspace.id));
      if (meta.generation !== workspace.generation || meta.status !== 'active') throw new Error('Obsolete image conversion.');
      const current = await this.request<OutboxEntry | undefined>(tx.objectStore('outbox').get(entry.key));
      if (!current) throw new Error('The queued image changed during conversion.');
      // Conversion changes the uploaded bytes. Persist them and give this repair
      // a fresh replay identity before the first request, then reuse it on retry.
      const operationId = createUuid();
      const prepared: OutboxEntry = { ...current, key: `${workspace.partition}|${operationId}`, operationId,
        syncId: operationId, payload: { ...(current.payload as any), filename }, lww: { ...current.lww, operationId } };
      tx.objectStore('outbox').delete(entry.key);
      tx.objectStore('outbox').put(prepared);
      const url = (current.payload as any).url;
      tx.objectStore('blobs').put({ key: `${workspace.partition}|media:${url}`, partition: workspace.partition, blobKey: `media:${url}`, value: blob });
      return prepared;
    });
  }

  async acknowledgeImage(workspace: Workspace, entry: OutboxEntry, url: string) {
    const source = (entry.payload as any).url as string;
    await this.atomic(['notes','baseline','outbox','blobs','workspaces'], async tx => {
      const meta = await this.request<Workspace>(tx.objectStore('workspaces').get(workspace.id));
      if (meta.generation !== workspace.generation || meta.status !== 'active') throw new Error('Obsolete image response.');
      for (const name of ['notes','baseline','outbox']) {
        const rows = await this.request<any[]>(tx.objectStore(name).index('partition').getAll(workspace.partition));
        for (const row of rows) {
          if (row.key === entry.key) continue;
          const field = name === 'outbox' ? 'payload' : 'value';
          if (name === 'baseline' && row.resourceType !== 'note') continue;
          if (name === 'outbox' && row.type !== 'note.upsert') continue;
          const text = JSON.stringify(row[field]);
          if (text?.includes(source)) { row[field] = JSON.parse(text.split(source).join(url)); tx.objectStore(name).put(row); }
        }
      }
      const blob = await this.request<any>(tx.objectStore('blobs').get(`${workspace.partition}|media:${source}`));
      if (blob) tx.objectStore('blobs').put({...blob,key:`${workspace.partition}|media:${url}`,blobKey:`media:${url}`});
      (meta as any).mediaAliases = {...(meta as any).mediaAliases,[source]:url};
      tx.objectStore('workspaces').put(meta);
      const aliases = this.offlineMediaCanonicalMap();
      aliases.forEach((canonical, objectUrl) => { if (canonical === source) aliases.set(objectUrl,url); });
      tx.objectStore('outbox').delete(entry.key);
    });
  }

  /** Baseline, acknowledgements, pending overlay and cursor advance are atomic. */
  async reconcile(
    workspace: Workspace,
    input: { snapshot?: Partial<Record<ResourceType, Record<string, any>[]>>; changes?: ResourceChange[];
      results?: MutationOutcome[]; sent?: OutboxEntry[]; cursor?: number; serverTime?: number }
  ) {
    return this.atomic([...Object.values(RESOURCE_STORES), 'baseline', 'outbox', 'syncState', 'workspaces', 'conflicts'], async tx => {
      const partition = workspace.partition;
      const meta = await this.request<Workspace | undefined>(tx.objectStore('workspaces').get(workspace.id));
      if (!meta || meta.generation !== workspace.generation || meta.status !== 'active') throw new Error('Obsolete synchronization response.');
      const priorState = await this.request<SyncState | undefined>(tx.objectStore('syncState').get(partition));
      const obsolete = input.cursor !== undefined && input.cursor < (priorState?.cursor || 0);
      const baseline = tx.objectStore('baseline');
      const affected = new Map<string, { type: ResourceType; syncId: string }>();
      const mark = (type: ResourceType, syncId: string) => affected.set(`${type}|${syncId}`, { type, syncId });
      // Position baselines live separately from content, so pending text edits
      // cannot restore an old position. They are not backup/migration resources.
      const positionIds = new Set<string>();
      const putPosition = async (syncId: string, value: any) => {
        const key = `${partition}|notePosition|${syncId}`;
        // The feed echoes our acknowledgement. Do not publish the same rank
        // twice or rebuild native snapshots for an unchanged echo.
        const previous = await this.request<any>(baseline.get(key));
        if (value && previous?.value?.sortOrder === value.sortOrder && previous.value.id === value.id) {
          const note = await this.request<StoredResource<NoteI> | undefined>(tx.objectStore('notes').get(this.resourceKey(partition,syncId)));
          if (note?.value.sortOrder === value.sortOrder) return;
        }
        if (value && Number.isFinite(value.sortOrder)) baseline.put({ key, partition, resourceType: 'notePosition', syncId, value });
        else baseline.delete(key);
        positionIds.add(syncId);
      };
      const putBase = async (type: ResourceType, syncId: string, value: any) => {
        if (type === 'note' && !input.snapshot?.note) {
          const position = await this.request<any>(baseline.get(`${partition}|notePosition|${syncId}`));
          if (position) await putPosition(syncId, value ? { ...position.value, sortOrder: value.sortOrder } : null);
        }
        baseline.put({ key: `${partition}|${type}|${syncId}`, partition, resourceType: type, syncId,
          value: type === 'note' && value ? cleanNoteMetadata(value) : value }); mark(type, syncId);
      };
      if (input.snapshot && !obsolete) {
        const old = await this.request<any[]>(baseline.index('partition').getAll(partition));
        for (const row of old) {
          if (row.resourceType === 'notePosition') {
            if (input.snapshot.note !== undefined) await putPosition(row.syncId, null);
            continue;
          }
          if (input.snapshot[row.resourceType as ResourceType] !== undefined) { baseline.delete(row.key); mark(row.resourceType, row.syncId); }
        }
        for (const [type, values] of Object.entries(input.snapshot) as [ResourceType, any[]][]) {
          const visible = await this.request<StoredResource<any>[]>(tx.objectStore(RESOURCE_STORES[type]).index('partition').getAll(partition));
          for (const row of visible) mark(type, row.syncId);
          for (const value of values) if (value.syncId) await putBase(type, value.syncId, value);
        }
      }
      for (const change of (input.changes || []).filter(change => !obsolete && change.sequence > (priorState?.cursor || 0))) {
        const value = change.operation === 'delete' ? null : change.payload;
        if (change.resourceType === 'notePosition') await putPosition(change.resourceSyncId, value);
        else await putBase(change.resourceType, change.resourceSyncId, value);
      }
      const sent = new Map((input.sent || []).map(entry => [entry.operationId, entry]));
      for (const outcome of input.results || []) {
        const operation = sent.get(outcome.operationId);
        if (!operation || !outcome.ok) continue;
        tx.objectStore('outbox').delete(operation.key);
        const type = operation.type.split('.')[0] as ResourceType;
        if (operation.type !== 'note.reorder' && !obsolete) {
          const value = outcome.canonical !== undefined ? outcome.canonical : operation.type.endsWith('.delete') ? null : { ...(operation.payload as any), ...(outcome.id != null ? { id: outcome.id } : {}) };
          await putBase(type, operation.syncId, value);
        }
        if (operation.type === 'note.reorder' && !obsolete) for (const position of outcome.positions || []) await putPosition(position.syncId, position);
        if (outcome.skipped) tx.objectStore('conflicts').put({ key: `${partition}|${operation.operationId}`, partition, operation, canonical: outcome.canonical, reason: 'The server retained a newer version.' });
      }
      const pending = await this.request<OutboxEntry[]>(tx.objectStore('outbox').index('partition').getAll(partition));
      pending.sort((a, b) => a.createdAt - b.createdAt ||
        (a.type === 'note.reorder' && b.type === 'note.reorder' ? (a.lww.logical || 0) - (b.lww.logical || 0) : 0) || a.operationId.localeCompare(b.operationId));
      // A parent's temporary ID may just have become canonical. Reproject its
      // queued children too, without touching unrelated pending resources.
      for (const operation of pending) {
        const type = operation.type.split('.')[0] as ResourceType;
        const parent = (operation.payload as any)?.noteSyncId;
        if (['reminder', 'attachment'].includes(type) && !operation.type.endsWith('.upload') && parent && affected.has(`note|${parent}`)) mark(type, operation.syncId);
      }
      const pendingByResource = new Map<string, OutboxEntry[]>();
      for (const operation of pending) {
        const key = `${operation.type.split('.')[0]}|${operation.syncId}`;
        const entries = pendingByResource.get(key) || [];
        entries.push(operation); pendingByResource.set(key, entries);
      }
      const noteStore = tx.objectStore('notes');
      const noteIds = new Set<string>();
      const markParentNote = async (value: any) => {
        if (value?.noteSyncId) noteIds.add(value.noteSyncId);
        else if (typeof value?.noteId === 'number') {
          const note = await this.request<StoredResource<any> | undefined>(noteStore.index('partitionId').get([partition, value.noteId]));
          if (note) noteIds.add(note.syncId);
        }
      };
      // Project notes first so related reminders/attachments can use canonical note IDs.
      for (const { type, syncId } of [...affected.values()].sort((a, b) => Number(b.type === 'note') - Number(a.type === 'note'))) {
        const record = await this.request<any>(baseline.get(`${partition}|${type}|${syncId}`));
        let value = record?.value || null;
        for (const op of pendingByResource.get(`${type}|${syncId}`) || []) {
          if (['note.reorder', 'attachment.upload', 'image.upload'].includes(op.type)) continue;
          value = op.type === 'note.binder' ? value && applyBinderMembership(value,op.payload as any) : op.type === 'note.organization'
            ? value && applyPersonalOrganization(value, op.payload as any)
            : op.type.endsWith('.delete') ? null : { ...value, ...(op.payload as any), ...(value?.id > 0 ? { id: value.id } : {}) };
        }
        const store = tx.objectStore(RESOURCE_STORES[type]);
        if (type === 'note') {
          noteIds.add(syncId);
          if (value) value = cleanNoteMetadata(value);
        }
        if (type === 'attachment') {
          const previous = await this.request<StoredResource<any> | undefined>(store.get(this.resourceKey(partition, syncId)));
          await markParentNote(previous?.value);
          await markParentNote(value);
        }
        if (!value) { store.delete(this.resourceKey(partition, syncId)); continue; }
        if ((type === 'reminder' || type === 'attachment') && value.noteSyncId) {
          const note = await this.request<StoredResource<any> | undefined>(tx.objectStore('notes').get(this.resourceKey(partition, value.noteSyncId)));
          if (note) value.noteId = note.value.id;
          else {store.delete(this.resourceKey(partition,syncId));continue;}
        }
        store.put({ key: this.resourceKey(partition, syncId), partition, syncId, value });
      }
      // Only catalogue/preferences changes can affect notes outside this page.
      // An empty poll must not read and rewrite the whole library.
      const allNotesAffected = [...affected.values()].some(item => ['label', 'preferences'].includes(item.type));
      if ([...affected.values()].some(item => item.type === 'preferences')) {
        const preferences = await this.request<StoredResource<any>[]>(tx.objectStore('preferences').index('partition').getAll(partition));
        if (preferences[0]) meta.preferences = { ...meta.preferences, ...preferences[0].value };
      }
      const notes = allNotesAffected
        ? await this.request<StoredResource<any>[]>(noteStore.index('partition').getAll(partition))
        : (await Promise.all([...new Set([...noteIds,...positionIds])].map(syncId => this.request<StoredResource<any> | undefined>(noteStore.get(this.resourceKey(partition, syncId))))))
          .filter((row): row is StoredResource<any> => !!row);
      const positionsByNote = new Map(await Promise.all(notes.map(async row => [row.syncId,
        await this.request<any>(baseline.get(`${partition}|notePosition|${row.syncId}`))] as const)));
      const needsContentProjection = allNotesAffected || noteIds.size > 0;
      const labels = needsContentProjection ? await this.request<StoredResource<any>[]>(tx.objectStore('labels').index('partition').getAll(partition)) : [];
      const labelsById = new Map(labels.map(row => [row.syncId, row.value]));
      const attachments = tx.objectStore('attachments');
      const attachmentGroups = new Map<string, StoredResource<any>[]>();
      if (needsContentProjection && notes.length > 50) {
        const rows = await this.request<StoredResource<any>[]>(attachments.index('partition').getAll(partition));
        for (const row of rows) for (const key of [`id:${row.value.noteId}`, `sync:${row.value.noteSyncId}`]) {
          const group = attachmentGroups.get(key) || [];
          group.push(row); attachmentGroups.set(key, group);
        }
      }
      const pendingOrder = new Map<string, number>();
      for (const op of pending.filter(op => op.type === 'note.reorder')) {
        const order = (op.payload as any).syncIds as string[];
        const positions = (op.payload as any).positions as Array<{syncId:string;sortOrder:number}> | undefined;
        if (positions) for (const position of positions) pendingOrder.set(position.syncId,position.sortOrder);
        else order.forEach((id, index) => pendingOrder.set(id, op.createdAt + order.length - index));
      }
      for (const row of notes) {
        const position = positionsByNote.get(row.syncId);
        const sortOrder = pendingOrder.get(row.syncId) ?? position?.value?.sortOrder ?? row.value.sortOrder;
        if (!allNotesAffected && !noteIds.has(row.syncId)) {
          if (row.value.sortOrder !== sortOrder) noteStore.put({ ...row, value: { ...row.value, sortOrder } });
          continue;
        }
        const related = new Map<string, StoredResource<any>>();
        const byId = notes.length > 50 ? attachmentGroups.get(`id:${row.value.id}`) || [] : typeof row.value.id === 'number'
          ? await this.request<StoredResource<any>[]>(attachments.index('partitionNoteId').getAll([partition, row.value.id])) : [];
        const bySyncId = notes.length > 50 ? attachmentGroups.get(`sync:${row.syncId}`) || []
          : await this.request<StoredResource<any>[]>(attachments.index('partitionNoteSyncId').getAll([partition, row.syncId]));
        for (const item of [...byId, ...bySyncId]) related.set(item.key, item);
        const value = projectSharedOrganization(row.value, meta.preferences);
        const projected = { ...value,
          attachments: [...related.values()].map(item => ({ ...item.value, noteId: value.id })),
          labels: (value.labels || []).map((label: any) => {
            const catalog = labelsById.get(label.syncId);
            return catalog ? { ...label, ...catalog, added: label.added } : label;
          }),
          sortOrder
        };
        if (JSON.stringify(row.value) !== JSON.stringify(projected)) noteStore.put({ ...row, value: projected });
      }
      const previous = await this.request<SyncState | undefined>(tx.objectStore('syncState').get(partition));
      tx.objectStore('syncState').put({ key: partition, partition, cursor: Math.max(input.cursor || 0,previous?.cursor || 0),
        serverOffsetMs: input.serverTime ? input.serverTime - Date.now() : previous?.serverOffsetMs || 0 });
      const changed = affected.size > 0 || positionIds.size > 0;
      if (changed) { meta.revision++; tx.objectStore('workspaces').put(meta); }
      return changed;
    });
  }

  private beginTransaction(db: IDBDatabase, stores: string[], mode: IDBTransactionMode) {
    if (mode === 'readwrite') {
      try { return db.transaction(stores, mode, { durability: 'strict' }); }
      catch (error) { if (!(error instanceof TypeError)) throw error; }
    }
    return db.transaction(stores, mode);
  }

  private async atomic<T>(stores: string[], work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = this.beginTransaction(db, [...new Set(stores)], 'readwrite');
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error('Local write failed.'));
      tx.onabort = () => reject(tx.error || new Error('Local write was aborted.'));
      work(tx).then(result => { value = result; }, error => { try { tx.abort(); } catch {} reject(error); });
    });
  }

  private resourceKey(partition: string, syncId: string) {
    return `${partition}|${syncId}`;
  }

  private async putResource<T>(storeName: string, partition: string, syncId: string, value: T) {
    const db = await this.open();
    const record: StoredResource<T> = { key: this.resourceKey(partition, syncId), partition, syncId, value };
    await this.transaction(db, [storeName], 'readwrite', stores => { stores[storeName].put(record); });
  }

  private async deleteResource(storeName: string, partition: string, syncId: string) {
    const db = await this.open();
    await this.transaction(db, [storeName], 'readwrite', stores => { stores[storeName].delete(this.resourceKey(partition, syncId)); });
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
        // Organization can change without advancing the shared content clock.
        ...(right.sharedOrganization ? { sharedOrganization: right.sharedOrganization, labels: right.labels, binder: right.binder } : {}),
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
          for (const name of ['notes', 'reminders', 'attachments', 'savedPlaces', 'outbox', 'blobs', 'labels', 'binders', 'preferences', 'baseline', 'receipts', 'conflicts', 'snapshotRows']) {
            if (!db.objectStoreNames.contains(name)) {
              const store = db.createObjectStore(name, { keyPath: 'key' });
              store.createIndex('partition', 'partition', { unique: false });
            }
          }
          if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('syncState')) db.createObjectStore('syncState', { keyPath: 'key' });
          const tx = request.transaction!;
          for (const [name, index, field] of [
            ['notes', 'partitionId', 'id'],
            ['attachments', 'partitionNoteId', 'noteId'],
            ['attachments', 'partitionNoteSyncId', 'noteSyncId']
          ]) {
            const store = tx.objectStore(name);
            if (!store.indexNames.contains(index)) store.createIndex(index, ['partition', `value.${field}`]);
          }
          for (const name of ['notes', 'baseline']) {
            const cursorRequest = tx.objectStore(name).openCursor();
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              const row = cursor.value;
              if ((name === 'notes' || row.resourceType === 'note') && row.value
                && takeoutSourceFields.some(field => Object.hasOwn(row.value, field))) {
                cursor.update({ ...row, value: cleanNoteMetadata(row.value) });
              }
              cursor.continue();
            };
          }
          // Do not rewrite queued payloads: their exact contents are part of
          // server replay fingerprints. They are cleaned when acknowledged.
        };
        request.onblocked = () => reject(new Error('Close other Kept windows to finish the storage upgrade.'));
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); this.database = undefined; };
          resolve(request.result);
        };
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
      const transaction = this.beginTransaction(db, storeNames, mode);
      const stores = Object.fromEntries(storeNames.map(name => [name, transaction.objectStore(name)]));
      try { work(stores); } catch (error) { transaction.abort(); reject(error); }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}
