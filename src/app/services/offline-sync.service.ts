import { prepareNoteImage } from '../utils/note-images';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { BehaviorSubject, firstValueFrom, Subject, Subscription } from 'rxjs';
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import { AuthService } from './auth.service';
import { OfflineStoreService, OutboxEntry } from './offline-store.service';
import { Workspace, ResourceType, ResourceChange, MutationOutcome, NativeAction } from '../interfaces/workspace';

export type OfflineSyncState = 'offline' | 'syncing' | 'saved' | 'error';

type SyncAppPlugin = {
  addListener(event: 'resume' | 'appStateChange', callback: (state?: { isActive?: boolean }) => void): Promise<PluginListenerHandle>;
};

type SyncSnapshot = {
  protocolVersion?: number;
  labels?: any[]; binders?: any[]; savedPlaces?: any[]; preferences?: any[];
  notes: NoteI[];
  reminders: ReminderI[];
  attachments: NoteAttachmentI[];
  cursor: number;
  serverTime: number;
};

type SyncChange = ResourceChange;

@Injectable({ providedIn: 'root' })
export class OfflineSyncService implements OnDestroy {
  readonly state$ = new BehaviorSubject<OfflineSyncState>(navigator.onLine ? 'saved' : 'offline');
  readonly lastSyncedAt$ = new BehaviorSubject<number | null>(null);
  readonly pendingCount$ = new BehaviorSubject(0);
  readonly storageBlocked$ = new BehaviorSubject(false);
  readonly storageFullMessage = "Your server's storage is full - please upgrade or delete some files/images.";
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
  protocolVersion = 1;
  private activeContext?: { partition: string; userId?: number; workspace: Workspace; epoch: number; headers: HttpHeaders };
  private epoch = 0;
  private pendingRead = 0;
  private serverGeneration = '';
  get generation() {return this.auth.isLocal ? this.auth.workspace.local?.generation : this.serverGeneration;}
  get writesLocally() { return this.auth.isLocal || this.protocolVersion >= 2; }
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
    this.authSubscription = (this.auth.accessChanges$ || this.auth.currentUser$).subscribe(user => {
      const previous = this.currentPartition;
      this.currentPartition = this.auth.isLocal ? this.auth.workspace.local?.partition || '' : user?.id ? this.store.partition(user.id) : '';
      if (previous !== this.currentPartition) {
        this.protocolVersion = 1; this.epoch++;
        try { if (localStorage.getItem(`kept_sync_protocol:${this.currentPartition}`) === '2') this.protocolVersion = 2; } catch {}
      }
      if (previous !== this.currentPartition) {
        this.clearRetryTimer();
        this.storageBlocked$.next(false);
        this.lastSyncedAt$.next(this.readLastSyncedAt());
        this.pendingRead++;
        this.pendingCount$.next(0);
        this.retryAttempt = 0;
        this.degradedUntil = 0;
        this.connectionUnavailable = !navigator.onLine;
        this.bootstrapIfEmptyRequested = false;
        if (this.currentPartition && !this.auth.isLocal) void this.refreshPendingCount();
      }
      if (!user && previous && !previous.startsWith('local:') && !this.currentPartition) {
        this.store.listOutbox(previous).then(pending => { if (!pending.length) return this.store.purgePartition(previous); return undefined; }).catch(console.error);
      }
      if (this.auth.isLocal) { if (previous !== this.currentPartition || this.state$.value !== 'error') this.state$.next('saved'); this.cacheChanged$.next(); }
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
    return this.auth.isLocal ? this.auth.workspace.local?.partition || '' : this.currentPartition;
  }

  async workspace() {
    await this.auth.workspace.ready;
    if (this.auth.isLocal) {
      if (!this.auth.workspace.local) throw new Error('Local workspace is not ready.');
      const workspace = await this.store.getWorkspace(this.auth.workspace.local.id);
      if (!workspace) throw new Error('The device workspace is missing.');
      return workspace;
    }
    if (!this.partition) throw new Error('No active workspace.');
    const workspace = await this.store.ensureServerWorkspace(this.partition);
    this.serverGeneration = workspace.generation;
    return workspace;
  }

  async commit<T extends Record<string, any>>(type: OutboxEntry['type'], syncId: string, payload: T, options?: { blobs?: Array<{ key: string; value: Blob }>; attachments?: Record<string,any>[]; action?: NativeAction }): Promise<T> {
    try {
      const value = await this.store.commitMutation(await this.workspace(), type, syncId, payload, options);
      this.cacheChanged$.next();
      if (this.auth.isLocal) this.state$.next('saved');
      else {
        await this.readPending();
        void this.syncNow().catch(console.error);
      }
      return value;
    } catch (error) { this.state$.next('error'); throw error; }
  }

  isConnectionDegraded() {
    return this.connectionUnavailable || Date.now() < this.degradedUntil;
  }

  private async readPending(partition = this.currentPartition, epoch = this.epoch) {
    if (!partition || this.auth.isLocal || this.destroyed || partition !== this.currentPartition || epoch !== this.epoch) return [];
    const read = ++this.pendingRead;
    const entries = await this.store.listOutbox(partition);
    if (!this.destroyed && !this.auth.isLocal && partition === this.currentPartition && epoch === this.epoch && read === this.pendingRead) {
      this.pendingCount$.next(entries.length);
    }
    return entries;
  }

  private readLastSyncedAt() {
    if (!this.currentPartition || this.auth.isLocal) return null;
    try {
      const time = Number(localStorage.getItem(`kept_last_synced_at:${this.currentPartition}`));
      return Number.isSafeInteger(time) && time > 0 && time <= Date.now() ? time : null;
    } catch { return null; }
  }

  private async refreshPendingCount(partition = this.currentPartition, epoch = this.epoch) {
    try { await this.readPending(partition, epoch); }
    catch (error) {
      if (!this.destroyed && partition === this.currentPartition && epoch === this.epoch) {
        this.state$.next('error');
        console.error('Could not read queued changes', error);
      }
    }
  }

  markConnectionDegraded(durationMs = 10000) {
    if (this.destroyed || this.auth.isLocal) return;
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
    if (this.auth.isLocal) { this.state$.next('saved'); return this.store.nextStamp(0); }
    if (!this.currentPartition) throw new Error('No active offline partition.');
    try {
      const syncState = await this.store.getSyncState(this.currentPartition);
      const stamp = this.store.nextStamp(syncState.serverOffsetMs);
      await this.store.enqueue(this.currentPartition, type, syncId, payload, stamp);
      await this.readPending();
      this.syncNow().catch(console.error);
      return stamp;
    } catch (error) {
      this.clearRetryTimer();
      this.state$.next('error');
      throw error;
    }
  }

  async syncNow(options: { bootstrapIfEmpty?: boolean; recovery?: boolean } = {}) {
    if (this.destroyed || this.auth.isLocal || !this.auth.currentUser || !this.currentPartition) return;
    if (options.bootstrapIfEmpty) this.bootstrapIfEmptyRequested = true;
    if (!navigator.onLine) {
      this.markConnectionDegraded();
      await this.refreshPendingCount();
      return;
    }
    if (this.running) {
      if (!options.recovery) this.rerun = true;
      return;
    }
    if (this.connectionUnavailable && !options.recovery) {
      this.scheduleDegradedRetries();
      await this.refreshPendingCount();
      return;
    }
    this.clearRetryTimer();
    this.running = true;

    const identity = {partition:this.partition,userId:this.auth.currentUser?.id,epoch:this.epoch,headers:this.auth.authHeaders()};
    const bootstrapIfEmpty = this.bootstrapIfEmptyRequested;
    this.bootstrapIfEmptyRequested = false;
    if (!this.connectionUnavailable) this.state$.next('syncing');
    try {
      const workspace = await this.workspace();
      this.protocolVersion = workspace.protocolVersion || this.protocolVersion;
      if (identity.epoch !== this.epoch || workspace.partition !== identity.partition) {const error = new Error('Workspace changed.');error.name='StaleSyncResponse';throw error;}
      this.activeContext = {...identity,workspace};
      const state = await this.store.getSyncState(this.currentPartition);
      const cachedNotes = bootstrapIfEmpty ? await this.store.listNotes(this.currentPartition) : [];
      const pending = await this.readPending(identity.partition, identity.epoch);
      this.storageBlocked$.next(pending.some(entry => entry.blockedBy === 'storage'));
      if (!pending.length && (state.cursor === 0 || (bootstrapIfEmpty && cachedNotes.length === 0))) {
        await this.bootstrap();
      }
      await this.flushOutbox();
      await this.pullChanges();
      const remaining = await this.readPending(identity.partition, identity.epoch);
      if (this.destroyed || identity.epoch !== this.epoch || identity.partition !== this.currentPartition) return;
      if (!navigator.onLine) this.markConnectionDegraded();
      else {
        this.clearConnectionDegraded();
        this.retryAttempt = 0;
        this.clearRetryTimer();
        if (!this.rerun) {
          // A reachable server isn't enough: pending media or another pass
          // must finish before we claim that everything has synchronized.
          if (!remaining.length) {
            const time = Date.now();
            this.lastSyncedAt$.next(time);
            // Optional UI history only; failure here must not fail a saved note.
            try { localStorage.setItem(`kept_last_synced_at:${identity.partition}`, String(time)); } catch {}
          }
          this.state$.next('saved');
        }
      }
    } catch (error) {
      if (this.destroyed || identity.epoch !== this.epoch || identity.partition !== this.currentPartition ||
          (error instanceof Error && error.name === 'StaleSyncResponse')) return;
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
      await this.refreshPendingCount(identity.partition, identity.epoch);
    } finally {
      this.running = false;
      this.activeContext = undefined;
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
        headers: this.requestHeaders(), params: { protocolVersion: '2' }
      })),
      this.syncRequestTimeoutMs
    );
    const workspace = this.activeContext?.workspace || await this.workspace();
    await this.store.reconcile(workspace, { snapshot: this.snapshotResources(snapshot), cursor: snapshot.cursor || 0, serverTime: snapshot.serverTime });
    if (snapshot.protocolVersion === 2) {
      this.protocolVersion = 2;
      await this.store.patchWorkspace(workspace.id, { protocolVersion: 2 });
      try { localStorage.setItem(`kept_sync_protocol:${workspace.partition}`,'2'); } catch {}
    }
    await this.applyCachedPreferences(workspace);
    await this.cacheSnapshotMedia(snapshot.notes || [],workspace.partition);
    this.cacheChanged$.next();
  }

  private async flushOutbox() {
    if (!this.currentPartition) return;
    let entries = await this.store.listOutbox(this.currentPartition);
    const workspace = this.activeContext?.workspace || await this.workspace();
    for (let entry of entries.filter(entry => entry.type === 'image.upload')) {
      let payload = entry.payload as any;
      let blob = await this.store.getBlob(workspace.partition, `media:${payload.url}`);
      if (!blob) throw new Error('An outgoing image is missing from device storage.');
      // Normalize legacy failed uploads too. Preserve already-supported JPEG
      // bytes so retrying an accepted upload keeps its original content hash.
      const prepared = await prepareNoteImage(blob, payload.filename || 'image', { keepJpegBytes: true });
      if (prepared.changed) {
        entry = await this.store.prepareQueuedImage(workspace, entry, prepared.blob, prepared.name);
        payload = entry.payload as any; blob = prepared.blob;
      }
      const form = new FormData(); form.append('image',blob,payload.filename || 'image'); form.append('operationId',entry.operationId);
      try {
        const uploaded = await this.withTimeout(firstValueFrom(this.http.post<{url:string}>(`${this.apiUrl}/uploads/images`,form,{headers:this.requestHeaders()})),this.syncRequestTimeoutMs);
        await this.store.acknowledgeImage(workspace,entry,uploaded.url);
      } catch (error) {
        await this.keepStorageBlockedUpload(error, workspace, entry);
      }
    }
    entries = await this.store.listOutbox(workspace.partition);
    const uploads = entries.filter(entry => entry.type === 'attachment.upload' || entry.type === 'attachment.upsert');
    // A note cannot publish device-only image URLs. Keep dependent changes
    // queued until their image uploads succeed, while unrelated edits proceed.
    const imageUrls = entries.filter(entry => entry.type === 'image.upload').map(entry => (entry.payload as { url: string }).url);
    const deferredNotes = new Set(entries.filter(entry => entry.type === 'note.upsert' &&
      imageUrls.some(url => JSON.stringify(entry.payload).includes(url))).map(entry => entry.syncId));
    const mutations = entries.filter(entry => !['image.upload','attachment.upload','attachment.upsert'].includes(entry.type) &&
      !(entry.type === 'note.upsert' && deferredNotes.has(entry.syncId)) &&
      !deferredNotes.has((entry.payload as any)?.noteSyncId));
    for (let offset = 0; offset < mutations.length; offset += 500) await this.flushMutations(mutations.slice(offset,offset + 500));
    if (uploads.length) await this.flushAttachmentUploads(uploads);
    const remaining = await this.store.listOutbox(workspace.partition);
    this.requestHeaders();
    this.storageBlocked$.next(remaining.some(entry => entry.blockedBy === 'storage'));
  }

  private async keepStorageBlockedUpload(error: unknown, workspace: Workspace, entry: OutboxEntry) {
    if (!(error instanceof HttpErrorResponse) || error.status !== 507) throw error;
    // A 507 proves the server is reachable. It is neither a network outage nor
    // a reason to discard local media or stop syncing other notes.
    this.requestHeaders();
    this.clearConnectionDegraded();
    if (await this.store.markUploadStorageBlocked(workspace, entry)) this.storageBlocked$.next(true);
  }

  private async flushMutations(entries: OutboxEntry[]) {
    if (!this.currentPartition || !entries.length) return;
    const response = await this.withTimeout(firstValueFrom(this.http.post<{
      protocolVersion?: number; results: MutationOutcome[];
      serverTime: number;
      snapshot?: SyncSnapshot;
    }>(`${this.apiUrl}/sync/mutations`, {
      protocolVersion: 2,
      mutations: entries.map(entry => ({
        operationId: entry.operationId,
        type: entry.type,
        syncId: entry.syncId,
        payload: entry.payload,
        lww: entry.lww
      }))
    }, { headers: this.requestHeaders() })), this.syncRequestTimeoutMs);
    const workspace = this.activeContext?.workspace || await this.workspace();
    const snapshot = response.snapshot ? this.snapshotResources(response.snapshot) : undefined;
    const results = (response.results || []).map((result, index) => {
      const entry = entries[index];
      const type = entry?.type.split('.')[0] as ResourceType;
      const canonical = snapshot?.[type]?.find(value => value['syncId'] === entry.syncId);
      return { ...result, operationId: result.operationId || entry?.operationId,
        ...(canonical ? { canonical } : {}) };
    });
    await this.store.reconcile(workspace, { results, sent: entries, snapshot,
      cursor: response.snapshot?.cursor, serverTime: response.serverTime });
    this.cacheChanged$.next();
    const pendingIds = new Set((await this.store.listOutbox(workspace.partition)).map(entry=>entry.operationId));
    const failed = results.find(result => !result.ok && pendingIds.has(result.operationId));
    if (failed) throw new Error(failed.error || 'A queued change could not be synchronized.');
  }

  private snapshotResources(snapshot: SyncSnapshot): Partial<Record<ResourceType, any[]>> {
    return { note: snapshot.notes || [], reminder: snapshot.reminders || [], attachment: snapshot.attachments || [],
      ...(snapshot.protocolVersion === 2 ? { label: snapshot.labels || [], binder: snapshot.binders || [], savedPlace: snapshot.savedPlaces || [], preferences: snapshot.preferences || [] } : {}) };
  }

  private async flushAttachmentUploads(entries: OutboxEntry[]) {
    if (!this.currentPartition) return;
    const workspace = this.activeContext?.workspace || await this.workspace();
    for (const entry of entries) {
      if (!(await this.store.listOutbox(workspace.partition)).some(pending=>pending.operationId === entry.operationId)) continue;
      const payload = entry.payload as {
        noteSyncId: string;
        blobKey: string;
        filename: string;
        syncId: string;
      };
      const note = (await this.store.listNotes(this.currentPartition)).find(item => item.syncId === payload.noteSyncId);
      if (!note?.id || note.id < 0) continue;
      const blob = await this.store.getBlob(workspace.partition, payload.blobKey || `attachment:${entry.syncId}`);
      if (!blob) {
        throw new Error('An outgoing attachment is missing from device storage.');
      }
      const formData = new FormData();
      formData.append('file', blob, payload.filename || (payload as any).originalName || 'attachment');
      formData.append('operationId', entry.operationId);
      formData.append('syncId', entry.syncId);
      try {
        const attachment = await this.withTimeout(
          firstValueFrom(this.http.post<NoteAttachmentI>(
            `${this.apiUrl}/notes/${note.id}/attachments?syncId=${encodeURIComponent(entry.syncId)}`,
            formData,
            { headers: this.requestHeaders() }
          )),
          this.syncRequestTimeoutMs
        );
        await this.store.putBlob(workspace.partition, `attachment:${entry.syncId}`, blob);
        await this.store.reconcile(workspace,{sent:[entry],results:[{ok:true,operationId:entry.operationId,canonical:attachment as any}]});
        this.cacheChanged$.next();
      } catch (error) {
        await this.keepStorageBlockedUpload(error, workspace, entry);
      }
    }
  }

  private async pullChanges() {
    if (!this.currentPartition) return;
    let state = await this.store.getSyncState(this.currentPartition);
    let hasMore = true;
    while (hasMore) {
      const response = await this.withTimeout(firstValueFrom(this.http.get<{
        protocolVersion?: number; changes: SyncChange[];
        cursor: number;
        hasMore: boolean;
        serverTime: number;
      }>(`${this.apiUrl}/sync/changes`, {
        headers: this.requestHeaders(),
        params: { cursor: String(state.cursor), limit: '500', protocolVersion: '2' }
      })), this.syncRequestTimeoutMs);
      const workspace = this.activeContext?.workspace || await this.workspace();
      await this.store.reconcile(workspace, { changes: response.changes || [], cursor: response.cursor ?? state.cursor, serverTime: response.serverTime });
      if (response.protocolVersion === 2 && this.protocolVersion !== 2) {
        await this.bootstrap();
      }
      state = await this.store.getSyncState(this.currentPartition);
      hasMore = !!response.hasMore;
    }
    await this.applyCachedPreferences(await this.workspace());
    this.cacheChanged$.next();
  }

  private async applyCachedPreferences(workspace: Workspace) {
    if (this.protocolVersion !== 2) return;
    const [preferences] = await this.store.listResources<any>('preferences',workspace.partition);
    if (preferences) this.auth.applyWorkspacePreferences(preferences);
  }

  private isOfflineError(error: unknown) {
    // The iOS native HTTP bridge uses -1 for transport failures; browser and
    // Android requests use 0. Neither status represents a server response.
    return this.isRequestTimeout(error) ||
      (error instanceof HttpErrorResponse && [-1, 0, 502, 503, 504].includes(error.status));
  }

  private requestHeaders() {
    if (this.activeContext && (this.activeContext.epoch !== this.epoch || this.partition !== this.activeContext.partition || this.auth.isLocal)) {
      const error = new Error('Obsolete synchronization request.');error.name = 'StaleSyncResponse';throw error;
    }
    return this.activeContext?.headers || this.auth.authHeaders();
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
      if (this.activeContext && (this.activeContext.epoch !== this.epoch || this.auth.isLocal || this.partition !== this.activeContext.partition || this.auth.currentUser?.id !== this.activeContext.userId)) {
        const error = new Error('Obsolete synchronization response.'); error.name = 'StaleSyncResponse'; throw error;
      }
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
    if (this.auth.isLocal || this.destroyed || !navigator.onLine || !this.currentPartition || this.retryTimer !== undefined) return;
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

  private async cacheSnapshotMedia(notes: NoteI[],partition = this.currentPartition) {
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
    for (const url of [...urls]
      .filter(url => !url.startsWith('data:') && !url.startsWith('blob:'))
      ) {
        try {
          await this.store.cacheMedia(partition, this.auth.canonicalImageUrl(url), await this.auth.prepareImageUrl(url));
        } catch { /* Missing media must not prevent notes from syncing. */ }
      }
  }
}
