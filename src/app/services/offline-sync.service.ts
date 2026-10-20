import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { BehaviorSubject, firstValueFrom, Subject, Subscription } from 'rxjs';
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import { AuthService } from './auth.service';
import { OfflineStoreService, OutboxEntry } from './offline-store.service';

export type OfflineSyncState = 'offline' | 'syncing' | 'saved' | 'error';

type SyncAppPlugin = {
  addListener(event: 'resume' | 'appStateChange', callback: (state?: { isActive?: boolean }) => void): Promise<PluginListenerHandle>;
};

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
export class OfflineSyncService implements OnDestroy {
  readonly state$ = new BehaviorSubject<OfflineSyncState>(navigator.onLine ? 'saved' : 'offline');
  readonly cacheChanged$ = new Subject<void>();
  private readonly apiUrl = environment.apiUrl;
  private readonly syncRequestTimeoutMs = 12000;
  private degradedUntil = 0;
  private connectionUnavailable = !navigator.onLine;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryAttempt = 0;
  private readonly retryDelays = [5000, 15000, 30000];
  private running = false;
  private rerun = false;
  private bootstrapIfEmptyRequested = false;
  private currentPartition = '';
  private destroyed = false;
  private authSubscription: Subscription;
  private appHandles: PluginListenerHandle[] = [];

  private recoverConnection = () => {
    this.zone.run(() => this.syncNow({ recovery: true }).catch(console.error));
  };

  private connectionLost = () => {
    this.zone.run(() => this.markConnectionDegraded());
  };

  private visibilityChanged = () => {
    if (document.visibilityState === 'visible') this.recoverConnection();
  };

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private store: OfflineStoreService,
    private zone: NgZone
  ) {
    this.authSubscription = this.auth.currentUser$.subscribe(user => {
      const previous = this.currentPartition;
      this.currentPartition = user?.id ? this.store.partition(user.id) : '';
      if (previous !== this.currentPartition) {
        this.clearRetryTimer();
        this.retryAttempt = 0;
        this.degradedUntil = 0;
        this.connectionUnavailable = !navigator.onLine;
        this.bootstrapIfEmptyRequested = false;
      }
      if (!user && previous) this.store.purgePartition(previous).catch(console.error);
      if (user) this.syncNow({ bootstrapIfEmpty: true }).catch(console.error);
    });
    window.addEventListener('online', this.recoverConnection);
    window.addEventListener('offline', this.connectionLost);
    document.addEventListener('visibilitychange', this.visibilityChanged);
    void this.bindAppResume();
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.authSubscription.unsubscribe();
    this.clearRetryTimer();
    window.removeEventListener('online', this.recoverConnection);
    window.removeEventListener('offline', this.connectionLost);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    for (const handle of this.appHandles) void handle.remove();
  }

  private async bindAppResume() {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('App')) return;
    const app = ((window as any).Capacitor?.Plugins?.App || registerPlugin<SyncAppPlugin>('App')) as SyncAppPlugin;
    for (const event of ['resume', 'appStateChange'] as const) {
      try {
        const handle = await app.addListener(event, state => {
          if (event === 'resume' || state?.isActive) this.recoverConnection();
        });
        if (this.destroyed) await handle.remove();
        else this.appHandles.push(handle);
      } catch (error) {
        console.warn('Could not register sync resume listener', error);
      }
    }
  }

  get partition() {
    return this.currentPartition;
  }

  isConnectionDegraded() {
    return this.connectionUnavailable || Date.now() < this.degradedUntil;
  }

  markConnectionDegraded(durationMs = 10000) {
    if (this.destroyed) return;
    this.connectionUnavailable = true;
    this.degradedUntil = Math.max(this.degradedUntil, Date.now() + durationMs);
    if (this.state$.value !== 'error') this.state$.next('offline');
    if (!navigator.onLine) this.clearRetryTimer();
    this.scheduleDegradedRetries();
  }

  clearConnectionDegraded() {
    this.degradedUntil = 0;
    if (this.destroyed || !navigator.onLine || !this.connectionUnavailable) return;
    // Called only after a successful server request, never just an online event.
    this.connectionUnavailable = false;
    this.retryAttempt = 0;
    this.clearRetryTimer();
    this.state$.next('syncing');
    if (!this.running) queueMicrotask(() => this.syncNow().catch(console.error));
  }

  async enqueue(type: OutboxEntry['type'], syncId: string, payload: unknown) {
    if (!this.currentPartition) throw new Error('No active offline partition.');
    try {
      const syncState = await this.store.getSyncState(this.currentPartition);
      const stamp = this.store.nextStamp(syncState.serverOffsetMs);
      await this.store.enqueue(this.currentPartition, type, syncId, payload, stamp);
      this.syncNow().catch(console.error);
      return stamp;
    } catch (error) {
      this.clearRetryTimer();
      this.state$.next('error');
      throw error;
    }
  }

  async syncNow(options: { bootstrapIfEmpty?: boolean; recovery?: boolean } = {}) {
    if (this.destroyed || !this.auth.currentUser || !this.currentPartition) return;
    if (options.bootstrapIfEmpty) this.bootstrapIfEmptyRequested = true;
    if (!navigator.onLine) {
      this.markConnectionDegraded();
      return;
    }
    if (this.running) {
      if (!options.recovery) this.rerun = true;
      return;
    }
    if (this.connectionUnavailable && !options.recovery) {
      this.scheduleDegradedRetries();
      return;
    }
    this.clearRetryTimer();
    this.running = true;
    const bootstrapIfEmpty = this.bootstrapIfEmptyRequested;
    this.bootstrapIfEmptyRequested = false;
    if (!this.connectionUnavailable) this.state$.next('syncing');
    try {
      const state = await this.store.getSyncState(this.currentPartition);
      const cachedNotes = bootstrapIfEmpty ? await this.store.listNotes(this.currentPartition) : [];
      const pending = await this.store.listOutbox(this.currentPartition);
      if (!pending.length && (state.cursor === 0 || (bootstrapIfEmpty && cachedNotes.length === 0))) {
        await this.bootstrap();
      }
      await this.flushOutbox();
      await this.pullChanges();
      if (this.destroyed) return;
      if (!navigator.onLine) this.markConnectionDegraded();
      else {
        this.clearConnectionDegraded();
        this.retryAttempt = 0;
        this.clearRetryTimer();
        if (!this.rerun) this.state$.next('saved');
      }
    } catch (error) {
      if (this.destroyed) return;
      this.bootstrapIfEmptyRequested ||= bootstrapIfEmpty;
      if (this.isOfflineError(error)) {
        this.markConnectionDegraded();
      }
      else {
        this.clearRetryTimer();
        this.rerun = false;
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
    const snapshot = await this.withTimeout(
      firstValueFrom(this.http.get<SyncSnapshot>(`${this.apiUrl}/sync/bootstrap`, {
        headers: this.auth.authHeaders()
      })),
      this.syncRequestTimeoutMs
    );
    await this.store.replaceSnapshot(
      this.currentPartition,
      snapshot.notes || [],
      snapshot.reminders || [],
      snapshot.attachments || [],
      snapshot.cursor || 0,
      snapshot.serverTime || Date.now()
    );
    await this.cacheSnapshotMedia(snapshot.notes || []);
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
    const response = await this.withTimeout(firstValueFrom(this.http.post<{
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
    }, { headers: this.auth.authHeaders() })), this.syncRequestTimeoutMs);
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
      await this.cacheSnapshotMedia(response.snapshot.notes || []);
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
      const attachment = await this.withTimeout(
        firstValueFrom(this.http.post<NoteAttachmentI>(
          `${this.apiUrl}/notes/${note.id}/attachments?syncId=${encodeURIComponent(payload.syncId)}`,
          formData,
          { headers: this.auth.authHeaders() }
        )),
        this.syncRequestTimeoutMs
      );
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
      const response = await this.withTimeout(firstValueFrom(this.http.get<{
        changes: SyncChange[];
        cursor: number;
        hasMore: boolean;
        serverTime: number;
      }>(`${this.apiUrl}/sync/changes`, {
        headers: this.auth.authHeaders(),
        params: { cursor: String(state.cursor), limit: '500' }
      })), this.syncRequestTimeoutMs);
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
    // The iOS native HTTP bridge uses -1 for transport failures; browser and
    // Android requests use 0. Neither status represents a server response.
    return this.isRequestTimeout(error) ||
      (error instanceof HttpErrorResponse && [-1, 0, 502, 503, 504].includes(error.status));
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Request timed out.');
            error.name = 'KeptRequestTimeout';
            reject(error);
          }, timeoutMs);
        })
      ]);
      this.clearConnectionDegraded();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private isRequestTimeout(error: unknown) {
    return error instanceof Error && error.name === 'KeptRequestTimeout';
  }

  private scheduleDegradedRetries() {
    if (this.destroyed || !navigator.onLine || !this.currentPartition || this.retryTimer !== undefined) return;
    const delay = this.retryDelays[Math.min(this.retryAttempt, this.retryDelays.length - 1)];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryAttempt += 1;
      this.zone.run(() => this.syncNow({ recovery: true }).catch(console.error));
    }, delay);
  }

  private clearRetryTimer() {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async cacheSnapshotMedia(notes: NoteI[]) {
    if (!this.currentPartition || !navigator.onLine) return;
    const urls = new Set<string>();
    for (const note of notes) {
      (note.images || []).forEach(image => {
        if (image.dataUrl) urls.add(image.dataUrl);
      });
      for (const match of String(note.noteBody || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
        if (match[1]) urls.add(match[1]);
      }
    }
    await Promise.all([...urls]
      .filter(url => !url.startsWith('data:') && !url.startsWith('blob:'))
      .map(async url => {
        try {
          await this.store.cacheMedia(this.currentPartition, this.auth.canonicalImageUrl(url), await this.auth.prepareImageUrl(url));
        } catch { /* Missing media must not prevent notes from syncing. */ }
      }));
  }
}
