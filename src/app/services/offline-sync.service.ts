import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, firstValueFrom, Subject } from 'rxjs';
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import { AuthService } from './auth.service';
import { OfflineStoreService, OutboxEntry } from './offline-store.service';

export type OfflineSyncState = 'offline' | 'syncing' | 'saved' | 'error';

type SyncSnapshot = {
  notes: NoteI[];
  reminders: ReminderI[];
  attachments: NoteAttachmentI[];
  cursor: number;
  serverTime: number;
};

type SyncChange = {
  sequence: number;
  resourceType: 'note' | 'reminder' | 'attachment';
  resourceSyncId: string;
  operation: 'upsert' | 'delete';
  payload: NoteI | ReminderI | NoteAttachmentI | null;
};

@Injectable({ providedIn: 'root' })
export class OfflineSyncService {
  readonly state$ = new BehaviorSubject<OfflineSyncState>(navigator.onLine ? 'saved' : 'offline');
  readonly cacheChanged$ = new Subject<void>();
  private readonly apiUrl = environment.apiUrl;
  private running = false;
  private rerun = false;
  private currentPartition = '';

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private store: OfflineStoreService,
    private zone: NgZone
  ) {
    this.auth.currentUser$.subscribe(user => {
      const previous = this.currentPartition;
      this.currentPartition = user?.id ? this.store.partition(user.id) : '';
      if (!user && previous) this.store.purgePartition(previous).catch(console.error);
      if (user) this.syncNow({ bootstrapIfEmpty: true }).catch(console.error);
    });
    window.addEventListener('online', () => this.zone.run(() => this.syncNow().catch(console.error)));
    window.addEventListener('offline', () => this.zone.run(() => this.state$.next('offline')));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        this.zone.run(() => this.syncNow().catch(console.error));
      }
    });
  }

  get partition() {
    return this.currentPartition;
  }

  async enqueue(type: OutboxEntry['type'], syncId: string, payload: unknown) {
    if (!this.currentPartition) throw new Error('No active offline partition.');
    const syncState = await this.store.getSyncState(this.currentPartition);
    const stamp = this.store.nextStamp(syncState.serverOffsetMs);
    await this.store.enqueue(this.currentPartition, type, syncId, payload, stamp);
    this.state$.next(navigator.onLine ? 'syncing' : 'offline');
    if (navigator.onLine) this.syncNow().catch(console.error);
    return stamp;
  }

  async syncNow(options: { bootstrapIfEmpty?: boolean } = {}) {
    if (!this.auth.currentUser || !this.currentPartition) return;
    if (!navigator.onLine) {
      this.state$.next('offline');
      return;
    }
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    this.state$.next('syncing');
    try {
      const state = await this.store.getSyncState(this.currentPartition);
      const cachedNotes = options.bootstrapIfEmpty ? await this.store.listNotes(this.currentPartition) : [];
      const pending = await this.store.listOutbox(this.currentPartition);
      if (!pending.length && (state.cursor === 0 || (options.bootstrapIfEmpty && cachedNotes.length === 0))) {
        await this.bootstrap();
      }
      await this.flushOutbox();
      await this.pullChanges();
      this.state$.next('saved');
    } catch (error) {
      if (this.isOfflineError(error)) this.state$.next('offline');
      else {
        this.state$.next('error');
        console.error('Offline sync failed', error);
      }
    } finally {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        queueMicrotask(() => this.syncNow().catch(console.error));
      }
    }
  }

  async bootstrap() {
    if (!this.currentPartition) return;
    const snapshot = await firstValueFrom(this.http.get<SyncSnapshot>(`${this.apiUrl}/sync/bootstrap`, {
      headers: this.auth.authHeaders()
    }));
    await this.store.replaceSnapshot(
      this.currentPartition,
      snapshot.notes || [],
      snapshot.reminders || [],
      snapshot.attachments || [],
      snapshot.cursor || 0,
      snapshot.serverTime || Date.now()
    );
    this.cacheChanged$.next();
  }

  private async flushOutbox() {
    if (!this.currentPartition) return;
    const entries = await this.store.listOutbox(this.currentPartition);
    if (!entries.length) return;
    const uploads = entries.filter(entry => entry.type === 'attachment.upload');
    const mutations = entries.filter(entry => entry.type !== 'attachment.upload');
    if (mutations.length) await this.flushMutations(mutations);
    if (uploads.length) await this.flushAttachmentUploads(uploads);
  }

  private async flushMutations(entries: OutboxEntry[]) {
    if (!this.currentPartition || !entries.length) return;
    const response = await firstValueFrom(this.http.post<{
      results: Array<{ ok: boolean; syncId?: string; id?: number; skipped?: boolean; error?: string }>;
      serverTime: number;
      snapshot?: SyncSnapshot;
    }>(`${this.apiUrl}/sync/mutations`, {
      mutations: entries.map(entry => ({
        type: entry.type,
        syncId: entry.syncId,
        payload: entry.payload,
        lww: entry.lww
      }))
    }, { headers: this.auth.authHeaders() }));
    const completed = entries.filter((entry, index) => response.results?.[index]?.ok);
    await this.store.removeOutbox(completed.map(entry => entry.key));
    const failed = response.results?.find(result => !result.ok);
    if (!failed && response.snapshot) {
      await this.store.replaceSnapshot(
        this.currentPartition,
        response.snapshot.notes || [],
        response.snapshot.reminders || [],
        response.snapshot.attachments || [],
        response.snapshot.cursor || 0,
        response.snapshot.serverTime || response.serverTime || Date.now()
      );
      this.cacheChanged$.next();
    } else if (response.serverTime) {
      const state = await this.store.getSyncState(this.currentPartition);
      await this.store.setSyncState(this.currentPartition, state.cursor, response.serverTime);
    }
    if (failed) throw new Error(failed.error || 'A queued change could not be synchronized.');
  }

  private async flushAttachmentUploads(entries: OutboxEntry[]) {
    if (!this.currentPartition) return;
    for (const entry of entries) {
      const payload = entry.payload as {
        noteSyncId: string;
        blobKey: string;
        filename: string;
        syncId: string;
      };
      const note = (await this.store.listNotes(this.currentPartition)).find(item => item.syncId === payload.noteSyncId);
      if (!note?.id || note.id < 0) continue;
      const blob = await this.store.getBlob(this.currentPartition, payload.blobKey);
      if (!blob) {
        await this.store.removeOutbox([entry.key]);
        continue;
      }
      const formData = new FormData();
      formData.append('file', blob, payload.filename || 'attachment');
      formData.append('syncId', payload.syncId);
      const attachment = await firstValueFrom(this.http.post<NoteAttachmentI>(
        `${this.apiUrl}/notes/${note.id}/attachments?syncId=${encodeURIComponent(payload.syncId)}`,
        formData,
        { headers: this.auth.authHeaders() }
      ));
      await this.store.putAttachment(this.currentPartition, attachment);
      const updatedNote = {
        ...note,
        attachments: [attachment, ...(note.attachments || []).filter(item => item.syncId !== payload.syncId)]
      };
      await this.store.putNote(this.currentPartition, updatedNote);
      await this.store.deleteBlob(this.currentPartition, payload.blobKey);
      await this.store.removeOutbox([entry.key]);
      this.cacheChanged$.next();
    }
  }

  private async pullChanges() {
    if (!this.currentPartition) return;
    let state = await this.store.getSyncState(this.currentPartition);
    let hasMore = true;
    while (hasMore) {
      const response = await firstValueFrom(this.http.get<{
        changes: SyncChange[];
        cursor: number;
        hasMore: boolean;
        serverTime: number;
      }>(`${this.apiUrl}/sync/changes`, {
        headers: this.auth.authHeaders(),
        params: { cursor: String(state.cursor), limit: '500' }
      }));
      for (const change of response.changes || []) await this.applyChange(change);
      await this.store.setSyncState(this.currentPartition, response.cursor || state.cursor, response.serverTime);
      state = await this.store.getSyncState(this.currentPartition);
      hasMore = !!response.hasMore;
    }
    this.cacheChanged$.next();
  }

  private async applyChange(change: SyncChange) {
    if (!this.currentPartition) return;
    if (change.resourceType === 'note') {
      if (change.operation === 'delete') await this.store.deleteNote(this.currentPartition, change.resourceSyncId);
      else if (change.payload) await this.store.putNote(this.currentPartition, change.payload as NoteI);
      return;
    }
    if (change.resourceType === 'reminder') {
      if (change.operation === 'delete') await this.store.deleteReminder(this.currentPartition, change.resourceSyncId);
      else if (change.payload) await this.store.putReminder(this.currentPartition, change.payload as ReminderI);
      return;
    }
    if (change.operation === 'delete') await this.store.deleteAttachment(this.currentPartition, change.resourceSyncId);
    else if (change.payload) await this.store.putAttachment(this.currentPartition, change.payload as NoteAttachmentI);
  }

  private isOfflineError(error: unknown) {
    return !navigator.onLine || (error instanceof HttpErrorResponse && error.status === 0);
  }
}
