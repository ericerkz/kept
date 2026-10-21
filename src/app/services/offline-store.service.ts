import { Capacitor } from '@capacitor/core';
import { Injectable } from '@angular/core';
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import type { LocationSavedPlace } from './location-saved-places.service';
import { createUuid } from '../utils/uuid';
import { createDemoNotes, demoWelcomeText } from '../utils/demo-notes';
import { CatalogItem, MutationOutcome, NativeAction, ResourceChange, ResourceType, RESOURCE_STORES, Workspace } from '../interfaces/workspace';

export type SyncResourceType = ResourceType;
export type SyncMutationType =
  | 'image.upload'
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
  private readonly databaseVersion = 3;
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
      'note.upsert': 0,
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
    options: { blobs?: Array<{ key: string; value: Blob }>; attachments?: Record<string,any>[]; action?: NativeAction } = {}
  ): Promise<T> {
    const stamp = this.nextStamp((await this.getSyncState(workspace.partition)).serverOffsetMs);
    return this.atomic([...Object.values(RESOURCE_STORES), 'outbox', 'blobs', 'workspaces', 'receipts', 'conflicts'], async tx => {
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
      const payload: Record<string, any> = { ...input, syncId };
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
      if (type === 'note.reorder') {
        const rows = await this.request<StoredResource<any>[]>(tx.objectStore('notes').index('partition').getAll(partition));
        const order = input['syncIds'] as string[];
        for (const row of rows) {
          const index = order.indexOf(row.syncId);
          if (index >= 0) { row.value.sortOrder = stamp.physicalMs + order.length - index; tx.objectStore('notes').put(row); }
        }
      } else if (type !== 'image.upload') {
        const store = tx.objectStore(RESOURCE_STORES[resource]);
        const key = this.resourceKey(partition, syncId);
        const previous = await this.request<StoredResource<any> | undefined>(store.get(key));
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
              for (const row of rows) if (row.value.noteId === previous?.value.id || row.value.noteSyncId === syncId) {
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
          if (resource === 'preferences') meta.preferences = { ...meta.preferences, ...input };
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
          const queued = await this.request<OutboxEntry[]>(tx.objectStore('outbox').index('partition').getAll(partition));
          for (const entry of queued.filter(entry=>entry.type === 'note.upsert')) {
            const value = entry.payload as any;
            if (resource === 'label') value.labels = (value.labels || []).flatMap((label:any)=>label.syncId === syncId || label.id === previous?.value.id
              ? type.endsWith('.delete') ? [] : [{...label,...payload}] : [label]);
            else if (previous && value.binder === previous.value.name) value.binder = type.endsWith('.delete') ? '' : payload['name'];
            // Preserve any operation already sent: changed content receives a new
            // replay identity, while its replacement remains in this transaction.
            const operationId = `${stamp.operationId}:note:${queued.indexOf(entry)}`;
            tx.objectStore('outbox').delete(entry.key);
            tx.objectStore('outbox').put({...entry,key:`${partition}|${operationId}`,operationId,payload:value,lww:{...stamp,operationId}});
          }
          const notes = await this.request<StoredResource<any>[]>(tx.objectStore('notes').index('partition').getAll(partition));
          for (const note of notes) {
            if (resource === 'label') note.value.labels = (note.value.labels || []).flatMap((label: any) =>
              label.syncId === syncId || label.id === previous?.value.id
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
      if (meta.mode === 'server') tx.objectStore('outbox').put({
        key: `${partition}|${stamp.operationId}`, partition, type, syncId, payload, lww: stamp,
        operationId: stamp.operationId, createdAt: stamp.physicalMs, attempts: 0
      } satisfies OutboxEntry);
      meta.revision++;
      meta.updatedAt = payload['updatedAt'];
      tx.objectStore('workspaces').put(meta);
      if (action) tx.objectStore('receipts').put({ key: `${partition}|${action.actionId}`, partition, actionId: action.actionId, result: payload, revision: meta.revision });
      return payload as T;
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
    await this.atomic([...Object.values(RESOURCE_STORES), 'baseline', 'outbox', 'syncState', 'workspaces', 'conflicts'], async tx => {
      const partition = workspace.partition;
      const meta = await this.request<Workspace | undefined>(tx.objectStore('workspaces').get(workspace.id));
      if (!meta || meta.generation !== workspace.generation || meta.status !== 'active') throw new Error('Obsolete synchronization response.');
      const priorState = await this.request<SyncState | undefined>(tx.objectStore('syncState').get(partition));
      const obsolete = input.cursor !== undefined && input.cursor < (priorState?.cursor || 0);
      const baseline = tx.objectStore('baseline');
      const affected = new Map<string, { type: ResourceType; syncId: string }>();
      const mark = (type: ResourceType, syncId: string) => affected.set(`${type}|${syncId}`, { type, syncId });
      const putBase = (type: ResourceType, syncId: string, value: any) => {
        baseline.put({ key: `${partition}|${type}|${syncId}`, partition, resourceType: type, syncId, value }); mark(type, syncId);
      };
      if (input.snapshot && !obsolete) {
        const old = await this.request<any[]>(baseline.index('partition').getAll(partition));
        for (const row of old) {
          if (input.snapshot[row.resourceType as ResourceType] !== undefined) { baseline.delete(row.key); mark(row.resourceType, row.syncId); }
        }
        for (const [type, values] of Object.entries(input.snapshot) as [ResourceType, any[]][]) {
          const visible = await this.request<StoredResource<any>[]>(tx.objectStore(RESOURCE_STORES[type]).index('partition').getAll(partition));
          for (const row of visible) mark(type, row.syncId);
          for (const value of values) if (value.syncId) putBase(type, value.syncId, value);
        }
      }
      for (const change of (input.changes || []).filter(change => !obsolete && change.sequence > (priorState?.cursor || 0))) putBase(change.resourceType, change.resourceSyncId, change.operation === 'delete' ? null : change.payload);
      const sent = new Map((input.sent || []).map(entry => [entry.operationId, entry]));
      for (const outcome of input.results || []) {
        const operation = sent.get(outcome.operationId);
        if (!operation || !outcome.ok) continue;
        tx.objectStore('outbox').delete(operation.key);
        const type = operation.type.split('.')[0] as ResourceType;
        if (operation.type !== 'note.reorder' && !obsolete) {
          const value = outcome.canonical !== undefined ? outcome.canonical : operation.type.endsWith('.delete') ? null : { ...(operation.payload as any), ...(outcome.id != null ? { id: outcome.id } : {}) };
          putBase(type, operation.syncId, value);
        }
        if (outcome.skipped) tx.objectStore('conflicts').put({ key: `${partition}|${operation.operationId}`, partition, operation, canonical: outcome.canonical, reason: 'The server retained a newer version.' });
      }
      const pending = await this.request<OutboxEntry[]>(tx.objectStore('outbox').index('partition').getAll(partition));
      pending.sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId));
      for (const operation of pending) if (!['note.reorder', 'attachment.upload', 'image.upload'].includes(operation.type)) mark(operation.type.split('.')[0] as ResourceType, operation.syncId);
      // Project notes first so related reminders/attachments can use canonical note IDs.
      for (const { type, syncId } of [...affected.values()].sort((a, b) => Number(b.type === 'note') - Number(a.type === 'note'))) {
        const record = await this.request<any>(baseline.get(`${partition}|${type}|${syncId}`));
        let value = record?.value || null;
        for (const op of pending.filter(op => op.syncId === syncId && op.type.split('.')[0] === type && op.type !== 'attachment.upload')) {
          value = op.type.endsWith('.delete') ? null : { ...value, ...(op.payload as any), ...(value?.id > 0 ? { id: value.id } : {}) };
        }
        const store = tx.objectStore(RESOURCE_STORES[type]);
        if (!value) { store.delete(this.resourceKey(partition, syncId)); continue; }
        if ((type === 'reminder' || type === 'attachment') && value.noteSyncId) {
          const note = await this.request<StoredResource<any> | undefined>(tx.objectStore('notes').get(this.resourceKey(partition, value.noteSyncId)));
          if (note) value.noteId = note.value.id;
          else {store.delete(this.resourceKey(partition,syncId));continue;}
        }
        store.put({ key: this.resourceKey(partition, syncId), partition, syncId, value });
      }
      const notes = await this.request<StoredResource<any>[]>(tx.objectStore('notes').index('partition').getAll(partition));
      const attachmentRows = await this.request<StoredResource<any>[]>(tx.objectStore('attachments').index('partition').getAll(partition));
      const labels = await this.request<StoredResource<any>[]>(tx.objectStore('labels').index('partition').getAll(partition));
      for (const row of notes) {
        row.value.attachments = attachmentRows.filter(item => item.value.noteId === row.value.id || item.value.noteSyncId === row.syncId).map(item => ({...item.value,noteId:row.value.id}));
        row.value.labels = (row.value.labels || []).map((label:any) => labels.find(item => item.syncId === label.syncId)?.value || label);
        tx.objectStore('notes').put(row);
      }
      for (const op of pending.filter(op => op.type === 'note.reorder')) {
        const order = (op.payload as any).syncIds as string[];
        for (const row of notes) { const index = order.indexOf(row.syncId); if (index >= 0) { row.value.sortOrder = op.createdAt + order.length - index; tx.objectStore('notes').put(row); } }
      }
      const previous = await this.request<SyncState | undefined>(tx.objectStore('syncState').get(partition));
      tx.objectStore('syncState').put({ key: partition, partition, cursor: Math.max(input.cursor || 0,previous?.cursor || 0),
        serverOffsetMs: input.serverTime ? input.serverTime - Date.now() : previous?.serverOffsetMs || 0 });
      meta.revision++;
      tx.objectStore('workspaces').put(meta);
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
