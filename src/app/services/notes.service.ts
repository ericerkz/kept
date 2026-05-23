import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom, Subscription } from 'rxjs';

export interface LinkPreviewData {
  title: string;
  description: string | null;
  image: string | null;
  url: string;
  domain: string;
}

export interface TakeoutImportResult {
  imported: number;
  skipped: number;
  deduped?: number;
  errors: number;
  pinnedCount?: number;
  total: number;
  fieldPresence?: Record<string, number>;
}

interface NotesCardPage {
  notes: NoteI[];
  nextCursor: string | null;
}
interface NotesLoadOptions {
  cacheBust?: boolean;
}
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI, UpdateKeyI } from './../interfaces/notes';
import { AuthService } from './auth.service';
import { ShareUserI } from '../interfaces/users';
import { ReminderService } from './reminder.service';

@Injectable({
  providedIn: 'root'
})
export class NotesService {
  private readonly apiUrl = `${environment.apiUrl}/notes`;
  notesList$ = new BehaviorSubject<NoteI[] | null>(null);
  activeEditors$ = new BehaviorSubject<{noteId: number, editors: any[]} | null>(null);
  private realtimeSocket?: WebSocket;
  private realtimeReconnect?: ReturnType<typeof setTimeout>;
  private readonly authSubscription: Subscription;
  private isLoading = false;
  private isLoadingNextPage = false;
  loading = false;
  hasLoaded = false;
  loadError = false;
  private nextCursor: string | null = null;
  private searchQuery = '';
  private searchReloadTimer?: ReturnType<typeof setTimeout>;
  private pendingLoadQuery?: string;
  private pendingLoadWaiters: Array<() => void> = [];
  private readonly cardPageSize = 80;
  private shouldReconnectRealtime = false;
  private preloadedPreviewUrls = new Set<string>();
  private previewPreloadQueue: string[] = [];
  private previewPreloadRunning = false;
  private suppressedRealtimeReloads = new Map<number, number>();
  private suppressNextReorderReloadUntil = 0;
  private optimisticNotes = new Map<number, NoteI>();
  private lastNonEmptyNotes: NoteI[] = [];

  constructor(private http: HttpClient, private auth: AuthService, private reminders: ReminderService) {
    this.authSubscription = this.auth.currentUser$.subscribe(user => {
      this.disconnectRealtime();
      if (user?.token) {
        this.connectRealtime(user.token);
      } else {
        this.loading = false;
        this.hasLoaded = false;
        this.loadError = false;
        this.nextCursor = null;
        this.lastNonEmptyNotes = [];
        this.notesList$.next(null);
      }
    });
  }

  async load(searchQuery = this.searchQuery, options: NotesLoadOptions = {}) {
    if (this.isLoading) {
      this.pendingLoadQuery = searchQuery;
      return new Promise<void>(resolve => this.pendingLoadWaiters.push(resolve));
    }
    this.isLoading = true;
    this.loading = true;
    this.loadError = false;
    try {
      this.searchQuery = searchQuery;
      const requestedQuery = searchQuery;
      const page = await this.loadCardPageWithRetry(requestedQuery, options.cacheBust);
      if (requestedQuery !== this.searchQuery) return;
      this.nextCursor = page.nextCursor;
      this.hasLoaded = true;
      const notes = this.withOptimisticNotes(page.notes);
      this.publishNotes(notes);
      this.queueLinkPreviewPreload(notes);
    } catch (error) {
      this.loadError = true;
      console.error(error);
    } finally {
      this.isLoading = false;
      this.loading = false;
      if (this.pendingLoadQuery !== undefined) {
        const pending = this.pendingLoadQuery;
        const waiters = this.pendingLoadWaiters.splice(0);
        this.pendingLoadQuery = undefined;
        await this.load(pending, options).catch(console.error);
        waiters.forEach(resolve => resolve());
      }
    }
  }

  private async loadCardPageWithRetry(searchQuery: string, cacheBust = false) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const params: Record<string, string> = { view: 'card', limit: String(this.cardPageSize) };
        if (searchQuery.trim()) params['q'] = searchQuery.trim();
        if (cacheBust) params['_'] = String(Date.now());
        return await firstValueFrom(this.http.get<NotesCardPage>(this.apiUrl, {
          headers: this.auth.authHeaders(),
          params
        }));
      } catch (error) {
        lastError = error;
        if (attempt === 2 || searchQuery !== this.searchQuery) break;
        await this.delay(250 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  setSearchQuery(query: string) {
    const next = query || '';
    if (next === this.searchQuery) return;
    this.searchQuery = next;
    if (this.searchReloadTimer) clearTimeout(this.searchReloadTimer);
    this.searchReloadTimer = setTimeout(() => {
      this.searchReloadTimer = undefined;
      this.load(next).catch(console.error);
    }, 250);
  }

  get hasMoreNotes() {
    return !!this.nextCursor;
  }

  async loadNextPage() {
    if (!this.nextCursor || this.isLoading || this.isLoadingNextPage) return;
    this.isLoadingNextPage = true;
    try {
      const requestedQuery = this.searchQuery;
      const params: Record<string, string> = { view: 'card', limit: String(this.cardPageSize), cursor: this.nextCursor };
      if (this.searchQuery.trim()) params['q'] = this.searchQuery.trim();
      const page = await firstValueFrom(this.http.get<NotesCardPage>(this.apiUrl, {
        headers: this.auth.authHeaders(),
        params
      }));
      if (requestedQuery !== this.searchQuery) return;
      this.nextCursor = page.nextCursor;
      const current = this.notesList$.value || [];
      const seen = new Set(current.map(note => note.id).filter(Boolean));
      const merged = [...current, ...page.notes.filter(note => !note.id || !seen.has(note.id))];
      this.publishNotes(merged);
      this.queueLinkPreviewPreload(page.notes);
    } finally {
      this.isLoadingNextPage = false;
    }
  }

  private connectRealtime(token: string) {
    this.shouldReconnectRealtime = true;
    const url = this.realtimeUrl(token);
    console.log('[Kept WS] connecting to', url.replace(/token=[^&]+/, 'token=***'));
    this.realtimeSocket = new WebSocket(url);
    const socket = this.realtimeSocket;

    this.realtimeSocket.onopen = () => {
      console.log('[Kept WS] connected');
      // Replay any notes we'd previously asked to be present in. This covers
      // (a) joinNote() calls issued while the socket was still handshaking,
      // and (b) reconnects after a server restart or network blip.
      for (const noteId of this.joinedNotes) {
        try {
          this.realtimeSocket!.send(JSON.stringify({ type: 'join-note', noteId }));
        } catch {
          // socket closed mid-replay; the next reconnect will retry.
        }
      }
    };

    this.realtimeSocket.onerror = (event) => {
      console.error('[Kept WS] error', event);
    };

    this.realtimeSocket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'notes-changed') {
          if (message.action === 'reordered' && this.suppressNextReorderReloadUntil > Date.now()) {
            this.suppressNextReorderReloadUntil = 0;
            return;
          }
          if (this.consumeSuppressedRealtimeReload(message.noteId)) return;
          this.load();
        }
        if (message.type === 'reminder-fired') this.reminders.handleFired(message);
        if (message.type === 'presence-update') this.activeEditors$.next({ noteId: message.noteId, editors: message.activeEditors || [] });
        if (message.type === 'global-presence') this.updateGlobalPresence(message.userId, message.online);
        if (message.type === 'profile-updated') this.updateUserProfile(message.user);
      } catch (error) {
        console.log(error);
      }
    };

    this.realtimeSocket.onclose = (event) => {
      console.warn('[Kept WS] closed', event.code, event.reason);
      if (this.realtimeSocket !== socket) return;
      if (!this.shouldReconnectRealtime || !this.auth.token) return;
      this.realtimeReconnect = setTimeout(() => this.connectRealtime(this.auth.token), 2000);
    };
  }

  // Track which notes we've asked the server to count us as "present" in.
  // The set is replayed every time the WS connects (initial connect + every
  // reconnect) so a join issued before the WS finished handshaking, or a
  // server restart that drops the socket, doesn't leave us invisible to
  // collaborators.
  private joinedNotes = new Set<number>();

  joinNote(noteId: number) {
    this.joinedNotes.add(noteId);
    if (this.realtimeSocket?.readyState === WebSocket.OPEN) {
      this.realtimeSocket.send(JSON.stringify({ type: 'join-note', noteId }));
    }
  }

  leaveNote(noteId: number) {
    this.joinedNotes.delete(noteId);
    if (this.realtimeSocket?.readyState === WebSocket.OPEN) {
      this.realtimeSocket.send(JSON.stringify({ type: 'leave-note', noteId }));
    }
  }

  private updateGlobalPresence(userId: number, online: boolean) {
    const notes = this.notesList$.value;
    if (!notes) return;
    let changed = false;
    notes.forEach(note => {
      let noteChanged = false;
      if (note.ownerUserId === userId) {
        if (note.ownerOnline !== online) {
          note.ownerOnline = online;
          noteChanged = true;
        }
      }
      if (note.collaborators) {
        note.collaborators.forEach(c => {
          if (c.id === userId) {
            if (c.online !== online) {
              c.online = online;
              noteChanged = true;
            }
          }
        });
      }
      if (noteChanged) changed = true;
    });
    if (changed) this.publishNotes([...notes]);
  }

  private updateUserProfile(user: ShareUserI) {
    if (!user?.id) return;
    const notes = this.notesList$.value;
    let changed = false;

    if (notes) {
      const next = notes.map(note => {
        let noteChanged = false;
        let updated = note;

        if (note.ownerUserId === user.id) {
          updated = {
            ...updated,
            ownerDisplayName: user.displayName,
            ownerUsername: user.username,
            ownerAvatarDataUrl: user.id === this.auth.currentUser?.id ? '' : (user.avatarDataUrl || ''),
            ownerAvatarPreset: user.avatarPreset || 'cat'
          };
          noteChanged = true;
        }

        if (note.collaborators?.some(c => c.id === user.id)) {
          updated = {
            ...updated,
            collaborators: note.collaborators.map(c => c.id === user.id ? {
              ...c,
              username: user.username,
              displayName: user.displayName,
              avatarDataUrl: user.id === this.auth.currentUser?.id ? '' : (user.avatarDataUrl || ''),
              avatarPreset: user.avatarPreset || 'cat'
            } : c)
          };
          noteChanged = true;
        }

        if (noteChanged) changed = true;
        return updated;
      });
      if (changed) this.publishNotes(next);
    }

    const activeEditors = this.activeEditors$.value;
    if (activeEditors?.editors?.some(editor => editor.id === user.id)) {
      this.activeEditors$.next({
        ...activeEditors,
        editors: activeEditors.editors.map(editor => editor.id === user.id ? {
          ...editor,
          username: user.username,
          displayName: user.displayName,
          avatarDataUrl: user.avatarDataUrl || '',
          avatarPreset: user.avatarPreset || 'cat'
        } : editor)
      });
    }
  }

  async deleteImage(note: NoteI, image: any, event?: Event) {
    if (event) event.stopPropagation();
    if (note.isCardPreview && note.id) note = await this.get(note.id);
    note.images = (note.images || []).filter(img => img.id !== image.id);
    await this.update(note, note.id!);
  }

  private disconnectRealtime() {
    this.shouldReconnectRealtime = false;
    if (this.realtimeReconnect) clearTimeout(this.realtimeReconnect);
    this.realtimeSocket?.close();
    this.realtimeSocket = undefined;
  }

  private realtimeUrl(token: string) {
    const encodedToken = encodeURIComponent(token);
    if (environment.apiUrl.startsWith('http')) {
      return `${environment.apiUrl.replace(/^http/, 'ws')}/realtime?token=${encodedToken}`;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${environment.apiUrl}/realtime?token=${encodedToken}`;
  }

  async add(noteObj: NoteI) {
    try {
      const result = await firstValueFrom(this.http.post<{ id: number }>(this.apiUrl, noteObj, { headers: this.auth.authHeaders() }));
      await this.ensureNotesVisible([result.id]);
      this.load(this.searchQuery, { cacheBust: true }).catch(console.error);
      return result.id;
    } catch (error) {
      console.log(error)
      return -1
    }
  }

  async update(object: NoteI, id: number) {
    if (id === -1) return;
    this.suppressRealtimeReload(id);
    try {
      await this.noteWriteWithRetry(
        () => firstValueFrom(this.http.put(`${this.apiUrl}/${id}`, object, { headers: this.auth.authHeaders() })),
        `update note ${id}`
      );
      this.mergeNoteIntoList({ ...object, id });
    } catch (error) {
      this.suppressedRealtimeReloads.delete(id);
      console.log(error)
    }
  }

  async updateKey(object: UpdateKeyI, id: number) {
    if (id === -1) return;
    this.suppressRealtimeReload(id);
    try {
      await this.noteWriteWithRetry(
        () => firstValueFrom(this.http.patch(`${this.apiUrl}/${id}`, object, { headers: this.auth.authHeaders() })),
        `update note fields ${id}`
      );
      this.mergeNoteIntoList({ ...object, id } as NoteI);
    } catch (error) {
      this.suppressedRealtimeReloads.delete(id);
      console.log(error)
    }
  }

  private async noteWriteWithRetry(write: () => Promise<unknown>, label: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await write();
      } catch (error) {
        lastError = error;
        if (attempt === 2 || !this.isRetryableNoteWriteError(error)) break;
        await this.delay(350 * (attempt + 1));
      }
    }
    console.warn(`Failed to ${label} after retries`, lastError);
    throw lastError;
  }

  private isRetryableNoteWriteError(error: unknown) {
    if (!(error instanceof HttpErrorResponse)) return true;
    return error.status === 0 || error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
  }

  async reorder(ids: number[]) {
    if (!ids.length) return;
    try {
      this.suppressNextReorderReloadUntil = Date.now() + 5000;
      this.reorderLoadedNotes(ids);
      await firstValueFrom(this.http.patch(`${this.apiUrl}/reorder`, { ids }, { headers: this.auth.authHeaders() }));
    } catch (error) {
      this.suppressNextReorderReloadUntil = 0;
      console.log(error)
      await this.load();
    }
  }

  private reorderLoadedNotes(ids: number[]) {
    const current = this.notesList$.value;
    if (!current) return;
    const byId = new Map(current.map(note => [note.id, note]));
    const ordered = ids.map(id => byId.get(id)).filter((note): note is NoteI => !!note);
    const orderedIds = new Set(ids);
    const remaining = current.filter(note => !note.id || !orderedIds.has(note.id));
    this.publishNotes([...ordered, ...remaining]);
  }

  async uploadImage(file: File) {
    const formData = new FormData();
    formData.append('image', file);
    return await firstValueFrom(this.http.post<{ url: string, name: string }>(
      `${environment.apiUrl}/uploads/images`,
      formData,
      { headers: this.auth.authHeaders() }
    ));
  }

  async uploadAttachment(noteId: number, file: File | Blob, filename?: string) {
    const formData = new FormData();
    formData.append('file', file, filename || (file instanceof File ? file.name : 'attachment'));
    return await firstValueFrom(this.http.post<NoteAttachmentI>(
      `${environment.apiUrl}/notes/${noteId}/attachments`,
      formData,
      { headers: this.auth.authHeaders() }
    ));
  }

  async deleteAttachment(noteId: number, attachmentId: number) {
    await firstValueFrom(this.http.delete(
      `${environment.apiUrl}/notes/${noteId}/attachments/${attachmentId}`,
      { headers: this.auth.authHeaders() }
    ));
  }

  async downloadAttachment(attachment: NoteAttachmentI) {
    const blob = await firstValueFrom(this.http.get(`${environment.apiUrl}/attachments/${attachment.id}`, {
      headers: this.auth.authHeaders(),
      responseType: 'blob'
    }));
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.originalName || 'attachment';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async get(id: number, options: { merge?: boolean } = {}) {
    if (id !== -1) {
      const note = await firstValueFrom(this.http.get<NoteI>(`${this.apiUrl}/${id}`, { headers: this.auth.authHeaders() }));
      if (options.merge !== false) this.mergeNoteIntoList(note);
      return note;
    } else return {} as NoteI
  }

  async ensureNotesVisible(ids: number[]) {
    const uniqueIds = [...new Set(ids.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0))];
    if (!uniqueIds.length) return;
    const notes = await Promise.all(uniqueIds.map(id => this.get(id, { merge: false }).catch(error => {
      console.error(error);
      return null;
    })));
    const visibleNotes = notes.filter((note): note is NoteI => !!note?.id);
    visibleNotes.forEach(note => this.optimisticNotes.set(note.id!, note));
    this.prependNotesIntoList(visibleNotes);
  }

  private prependNotesIntoList(notes: NoteI[]) {
    if (!notes.length) return;
    const currentValue = this.notesList$.value || [];
    const current = currentValue.length ? currentValue : this.lastNonEmptyNotes;
    const incomingIds = new Set(notes.map(note => note.id).filter(Boolean));
    const next = [
      ...notes,
      ...current.filter(note => !note.id || !incomingIds.has(note.id))
    ];
    this.publishNotes(next);
    this.queueLinkPreviewPreload(notes);
  }

  private publishNotes(notes: NoteI[]) {
    if (notes.length) this.lastNonEmptyNotes = notes;
    this.notesList$.next(notes);
  }

  private withOptimisticNotes(notes: NoteI[]) {
    if (!this.optimisticNotes.size) return notes;
    const seen = new Set(notes.map(note => note.id).filter(Boolean));
    for (const id of [...this.optimisticNotes.keys()]) {
      if (seen.has(id)) this.optimisticNotes.delete(id);
    }
    const missing = [...this.optimisticNotes.values()].filter(note => note.id && !seen.has(note.id));
    return missing.length ? [...missing, ...notes] : notes;
  }

  private mergeNoteIntoList(note: NoteI) {
    const current = this.notesList$.value;
    if (!current || !note.id) return;
    const index = current.findIndex(item => item.id === note.id);
    if (index < 0) return;
    const existing = current[index];
    const attachments = note.attachments ?? existing.attachments;
    const collaborators = note.collaborators?.length ? note.collaborators : existing.collaborators;
    const next = [...current];
    next[index] = {
      ...existing,
      ...note,
      attachments,
      collaborators,
      hasAttachments: !!(attachments?.length || existing.hasAttachments),
      attachmentCount: attachments?.length ?? existing.attachmentCount,
      searchText: existing.searchText,
      isCardPreview: note.isCardPreview ?? (note.noteBody !== undefined ? false : existing.isCardPreview)
    };
    this.publishNotes(next);
  }

  private suppressRealtimeReload(noteId: number) {
    this.suppressedRealtimeReloads.set(noteId, Date.now() + 5000);
  }

  private consumeSuppressedRealtimeReload(noteId: number) {
    const id = Number(noteId);
    const expiresAt = this.suppressedRealtimeReloads.get(id);
    if (!expiresAt) return false;
    this.suppressedRealtimeReloads.delete(id);
    return expiresAt > Date.now();
  }

  async getAll() {
    return await firstValueFrom(this.http.get<NoteI[]>(this.apiUrl, { headers: this.auth.authHeaders() }));
  }

  async listShareUsers() {
    return await firstValueFrom(this.http.get<ShareUserI[]>(`${environment.apiUrl}/sharing/users`, { headers: this.auth.authHeaders() }));
  }

  async getCollaborators(id: number) {
    if (id !== -1) {
      return await firstValueFrom(this.http.get<ShareUserI[]>(`${this.apiUrl}/${id}/collaborators`, { headers: this.auth.authHeaders() }));
    } else return []
  }

  async rejoin(noteId: number, userId: number) {
    await firstValueFrom(this.http.post(`${this.apiUrl}/${noteId}/collaborators/rejoin`, { userId }, { headers: this.auth.authHeaders() }));
    this.load();
  }

  async updateCollaborators(id: number, userIds: number[]) {
    if (id !== -1) {
      const users = await firstValueFrom(this.http.put<ShareUserI[]>(
        `${this.apiUrl}/${id}/collaborators`,
        { userIds },
        { headers: this.auth.authHeaders() }
      ));
      this.mergeCollaboratorsIntoList(id, users);
      this.load().catch(console.error);
      return users;
    } else return []
  }

  private mergeCollaboratorsIntoList(id: number, collaborators: ShareUserI[]) {
    const current = this.notesList$.value;
    if (!current) return;
    const index = current.findIndex(note => note.id === id);
    if (index < 0) return;
    const next = [...current];
    next[index] = { ...next[index], collaborators };
    this.publishNotes(next);
  }

  async clone(id: number) {
    if (id !== -1) {
      try {
        await firstValueFrom(this.http.post(`${this.apiUrl}/${id}/clone`, {}, { headers: this.auth.authHeaders() }));
        await this.load();
      } catch (error) {
        console.log(error)
      }
    }
  }

  async merge(orderedIds: number[]): Promise<number | null> {
    try {
      const result = await firstValueFrom(
        this.http.post<{ id: number }>(`${this.apiUrl}/merge`, { orderedIds }, { headers: this.auth.authHeaders() })
      );
      await this.load();
      return result?.id ?? null;
    } catch (error: any) {
      console.log(error);
      throw error;
    }
  }

  private linkPreviewCache = new Map<string, Promise<LinkPreviewData>>();
  private linkPreviewResolved = new Map<string, LinkPreviewData>();

  getLinkPreview(url: string): Promise<LinkPreviewData> {
    if (!this.linkPreviewCache.has(url)) {
      const promise = firstValueFrom(
        this.http.get<LinkPreviewData>(`${environment.apiUrl}/link-preview`, {
          params: { url },
          headers: this.auth.authHeaders()
        })
      );
      this.linkPreviewCache.set(url, promise);
      promise.then(data => this.linkPreviewResolved.set(url, data)).catch(() => undefined);
    }
    return this.linkPreviewCache.get(url)!;
  }

  // Synchronous lookup used by LinkPreviewComponent so it can skip rendering
  // a loading skeleton when a preview was already preloaded.
  peekLinkPreviewCache(url: string): LinkPreviewData | null {
    return this.linkPreviewResolved.get(url) || null;
  }

  private queueLinkPreviewPreload(notes: NoteI[]) {
    // Notes arrive sorted by recency / pinned-first, so URLs from the first
    // ~80 notes are the ones the user is about to see. Queue those first
    // so IntersectionObserver-based fetches in the rendered LinkPreview
    // components hit the resolved cache instead of triggering HTTP.
    const seen = new Set<string>();
    const prioritized: string[] = [];
    const deferred: string[] = [];
    notes.forEach((note, index) => {
      for (const url of this.noteUrls(note)) {
        if (seen.has(url) || this.preloadedPreviewUrls.has(url)) continue;
        seen.add(url);
        if (index < 80) prioritized.push(url);
        else deferred.push(url);
      }
    });
    const urls = prioritized.concat(deferred);
    if (!urls.length) return;
    urls.forEach(url => this.preloadedPreviewUrls.add(url));
    this.previewPreloadQueue.push(...urls);
    if (this.previewPreloadRunning) return;
    this.previewPreloadRunning = true;
    // Kick off immediately — no 250ms delay. The frontend has already
    // painted whatever it can without these previews; getting them back
    // ASAP just lets the cards fill in faster.
    queueMicrotask(() => this.preloadLinkPreviews());
  }

  private async preloadLinkPreviews() {
    // Run a small pool of fetches in parallel. The browser caps connections
    // per origin, so 6 is a safe sweet spot — enough to keep the pipeline
    // full without exhausting the server thread on cold-cache scrapes.
    const concurrency = 6;
    const workers: Promise<void>[] = [];
    const next = async () => {
      while (this.previewPreloadQueue.length) {
        const url = this.previewPreloadQueue.shift()!;
        await this.getLinkPreview(url).catch(() => undefined);
      }
    };
    try {
      for (let i = 0; i < concurrency; i++) workers.push(next());
      await Promise.all(workers);
    } finally {
      this.previewPreloadRunning = false;
    }
  }

  private noteUrls(note: NoteI) {
    const plainBody = String(note.noteBody || '').replace(/<[^>]+>/g, ' ');
    const matches = plainBody.match(/https?:\/\/[^\s"'<>]+/g) || [];
    return [...new Set(matches)].slice(0, 3);
  }

  async importGoogleTakeout(file: File): Promise<TakeoutImportResult> {
    const formData = new FormData();
    formData.append('takeout', file);
    const result = await firstValueFrom(
      this.http.post<TakeoutImportResult>(`${environment.apiUrl}/import/google-takeout`, formData, {
        headers: this.auth.authHeaders()
      })
    );
    await this.load();
    return result;
  }

  async delete(id: number) {
    if (id !== -1) {
      try {
        await firstValueFrom(this.http.delete(`${this.apiUrl}/${id}`, { headers: this.auth.authHeaders() }));
        await this.load();
      } catch (error) {
        console.log(error)
      }
    }
  }

  async updateAllLabels(labelId: number, labelValue: string) {
    try {
      await firstValueFrom(this.http.patch(
        `${this.apiUrl}/labels/${labelId}`,
        { name: labelValue },
        { headers: this.auth.authHeaders() }
      ));
      await this.load();
    } catch (error) {
      console.log(error)
    }
  }
}
