import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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
  private nextCursor: string | null = null;
  private searchQuery = '';
  private searchReloadTimer?: ReturnType<typeof setTimeout>;
  private pendingLoadQuery?: string;
  private readonly cardPageSize = 80;
  private shouldReconnectRealtime = false;
  private preloadedPreviewUrls = new Set<string>();
  private previewPreloadQueue: string[] = [];
  private previewPreloadRunning = false;

  constructor(private http: HttpClient, private auth: AuthService, private reminders: ReminderService) {
    this.authSubscription = this.auth.currentUser$.subscribe(user => {
      this.disconnectRealtime();
      if (user?.token) this.connectRealtime(user.token);
    });
  }

  async load(searchQuery = this.searchQuery) {
    if (this.isLoading) {
      this.pendingLoadQuery = searchQuery;
      return;
    }
    this.isLoading = true;
    try {
      this.searchQuery = searchQuery;
      const requestedQuery = searchQuery;
      const params: Record<string, string> = { view: 'card', limit: String(this.cardPageSize) };
      if (this.searchQuery.trim()) params['q'] = this.searchQuery.trim();
      const page = await firstValueFrom(this.http.get<NotesCardPage>(this.apiUrl, {
        headers: this.auth.authHeaders(),
        params
      }));
      if (requestedQuery !== this.searchQuery) return;
      this.nextCursor = page.nextCursor;
      this.notesList$.next(page.notes);
      this.queueLinkPreviewPreload(page.notes);
    } finally {
      this.isLoading = false;
      if (this.pendingLoadQuery !== undefined) {
        const pending = this.pendingLoadQuery;
        this.pendingLoadQuery = undefined;
        this.load(pending).catch(console.error);
      }
    }
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
      this.notesList$.next(merged);
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
        if (message.type === 'notes-changed') this.load();
        if (message.type === 'reminder-fired') this.reminders.handleFired(message);
        if (message.type === 'presence-update') this.activeEditors$.next({ noteId: message.noteId, editors: message.activeEditors || [] });
        if (message.type === 'global-presence') this.updateGlobalPresence(message.userId, message.online);
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
    if (changed) this.notesList$.next([...notes]);
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
      await this.load();
      return result.id;
    } catch (error) {
      console.log(error)
      return -1
    }
  }

  async update(object: NoteI, id: number) {
    if (id !== -1) {
      try {
        await firstValueFrom(this.http.put(`${this.apiUrl}/${id}`, object, { headers: this.auth.authHeaders() }));
        await this.load();
      } catch (error) {
        console.log(error)
      }
    }
  }

  async updateKey(object: UpdateKeyI, id: number) {
    if (id !== -1) {
      try {
        await firstValueFrom(this.http.patch(`${this.apiUrl}/${id}`, object, { headers: this.auth.authHeaders() }));
        await this.load();
      } catch (error) {
        console.log(error)
      }
    }
  }

  async reorder(ids: number[]) {
    if (!ids.length) return;
    try {
      await firstValueFrom(this.http.patch(`${this.apiUrl}/reorder`, { ids }, { headers: this.auth.authHeaders() }));
      await this.load();
    } catch (error) {
      console.log(error)
    }
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

  async get(id: number) {
    if (id !== -1) {
      const note = await firstValueFrom(this.http.get<NoteI>(`${this.apiUrl}/${id}`, { headers: this.auth.authHeaders() }));
      this.mergeNoteIntoList(note);
      return note;
    } else return {} as NoteI
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
      isCardPreview: false
    };
    this.notesList$.next(next);
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
      await this.load();
      return users;
    } else return []
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
