import { Injectable, NgZone } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { AuthService } from './auth.service';
import { NotesService } from './notes.service';
import { NoteI, NoteImageI } from '../interfaces/notes';
import { Subscription } from 'rxjs';

type PluginListenerHandle = { remove: () => Promise<void> | void };

type ShareFileReference = {
  id?: string;
  filename?: string;
  pathInContainer: string;
  directUrl?: string;
  mimeType?: string;
  fileSize?: number;
};

type ShareIntent = {
  intentId: string;
  sourceType: 'url' | 'plainText' | 'image' | 'file' | 'mixed';
  content?: string | null;
  url?: string | null;
  fileReferences?: ShareFileReference[];
};

type KeptShareIntentsPlugin = {
  addListener: (
    eventName: 'shareIntent',
    listenerFunc: (intent: ShareIntent) => void
  ) => Promise<PluginListenerHandle>;
  processQueue: () => Promise<{ successCount: number; failureCount: number }>;
  getFileURL: (options: { relativePath: string }) => Promise<{ url: string }>;
  markProcessed: (options: { intentId: string }) => Promise<void>;
  getPendingCount?: () => Promise<{ count: number }>;
};

type CapacitorAppPlugin = {
  addListener: (
    eventName: 'appStateChange' | 'resume',
    listenerFunc: (event?: { isActive?: boolean }) => void
  ) => Promise<PluginListenerHandle>;
};

const KeptShareIntents = registerPlugin<KeptShareIntentsPlugin>('KeptShareIntents');
const CapacitorApp = registerPlugin<CapacitorAppPlugin>('App');

@Injectable({ providedIn: 'root' })
export class ShareIntentsService {
  private initialized = false;
  private listenerHandle?: PluginListenerHandle;
  private appStateHandle?: PluginListenerHandle;
  private appResumeHandle?: PluginListenerHandle;
  private authSubscription?: Subscription;
  private visibilityListener?: () => void;
  private focusListener?: () => void;
  private vaultUnlockedListener?: () => void;
  private listenerRetryTimer?: number;
  private listenerRetryCount = 0;
  private processQueueTimer?: number;
  private processQueueBurstTimer?: number;
  private processQueueBurstUntil = 0;
  private processQueueInFlight = false;
  private processQueueAgain = false;
  private processingIntentIds = new Set<string>();
  private readonly pendingNoteKeyPrefix = 'kept_share_intent_note:';

  constructor(
    private auth: AuthService,
    private notes: NotesService,
    private zone: NgZone
  ) {}

  async init() {
    const platform = Capacitor.getPlatform();
    const hasNativePlugin = !!(window as any).Capacitor?.Plugins?.KeptShareIntents;
    if (this.initialized || (platform !== 'ios' && platform !== 'android' && !hasNativePlugin)) return;
    this.initialized = true;

    try {
      this.listenerHandle = await KeptShareIntents.addListener('shareIntent', intent => {
        this.zone.run(() => this.handleIntent(intent).catch(console.error));
      });
      this.listenerRetryCount = 0;
    } catch (error) {
      console.warn('Kept share intents listener unavailable', error);
      this.initialized = false;
      this.scheduleListenerRetry();
      return;
    }

    await this.registerQueueTriggers();
    this.authSubscription = this.auth.currentUser$.subscribe(user => {
      if (!user?.token && !this.notes.isKept2LocalFirstActive()) return;
      this.requestProcessQueueBurst();
    });
  }

  async destroy() {
    if (this.processQueueTimer) window.clearTimeout(this.processQueueTimer);
    if (this.processQueueBurstTimer) window.clearTimeout(this.processQueueBurstTimer);
    if (this.listenerRetryTimer) window.clearTimeout(this.listenerRetryTimer);
    await this.listenerHandle?.remove();
    await this.appStateHandle?.remove();
    await this.appResumeHandle?.remove();
    if (this.visibilityListener) document.removeEventListener('visibilitychange', this.visibilityListener);
    if (this.focusListener) window.removeEventListener('focus', this.focusListener);
    if (this.vaultUnlockedListener) window.removeEventListener('kept2-vault-unlocked', this.vaultUnlockedListener);
    this.authSubscription?.unsubscribe();
    this.processQueueTimer = undefined;
    this.listenerHandle = undefined;
    this.appStateHandle = undefined;
    this.appResumeHandle = undefined;
    this.visibilityListener = undefined;
    this.focusListener = undefined;
    this.vaultUnlockedListener = undefined;
    this.authSubscription = undefined;
    this.listenerRetryTimer = undefined;
    this.listenerRetryCount = 0;
    this.processQueueBurstTimer = undefined;
    this.processQueueBurstUntil = 0;
    this.processQueueInFlight = false;
    this.processQueueAgain = false;
    this.initialized = false;
  }

  private scheduleListenerRetry() {
    if (this.listenerRetryCount >= 10) return;
    if (this.listenerRetryTimer) window.clearTimeout(this.listenerRetryTimer);
    this.listenerRetryCount += 1;
    this.listenerRetryTimer = window.setTimeout(() => {
      this.listenerRetryTimer = undefined;
      this.init().catch(console.error);
    }, 1000);
  }

  private async registerQueueTriggers() {
    this.visibilityListener = () => {
      if (document.visibilityState === 'visible') this.zone.run(() => this.requestProcessQueueBurst(150));
    };
    this.focusListener = () => this.zone.run(() => this.requestProcessQueueBurst(150));
    this.vaultUnlockedListener = () => this.zone.run(() => this.requestProcessQueueBurst(150));
    document.addEventListener('visibilitychange', this.visibilityListener);
    window.addEventListener('focus', this.focusListener);
    window.addEventListener('kept2-vault-unlocked', this.vaultUnlockedListener);

    try {
      this.appStateHandle = await CapacitorApp.addListener('appStateChange', event => {
        if (event?.isActive) this.zone.run(() => this.requestProcessQueueBurst(150));
      });
      this.appResumeHandle = await CapacitorApp.addListener('resume', () => {
        this.zone.run(() => this.requestProcessQueueBurst(150));
      });
    } catch (error) {
      console.warn('Kept share intents resume listener unavailable', error);
    }
  }

  private requestProcessQueueBurst(delay = 0) {
    if (!this.canProcessSharedIntents()) return;
    this.processQueueBurstUntil = Math.max(this.processQueueBurstUntil, Date.now() + 12000);
    this.requestProcessQueue(delay);
    this.scheduleNextQueueBurstTick(delay + 1500);
  }

  private scheduleNextQueueBurstTick(delay = 1500) {
    if (this.processQueueBurstTimer) window.clearTimeout(this.processQueueBurstTimer);
    this.processQueueBurstTimer = window.setTimeout(() => {
      this.processQueueBurstTimer = undefined;
      if (!this.canProcessSharedIntents() || Date.now() > this.processQueueBurstUntil) return;
      this.requestProcessQueue();
      this.scheduleNextQueueBurstTick();
    }, delay);
  }

  private requestProcessQueue(delay = 0) {
    if (!this.canProcessSharedIntents()) return;
    if (this.processQueueTimer) window.clearTimeout(this.processQueueTimer);
    this.processQueueTimer = window.setTimeout(() => {
      this.processQueueTimer = undefined;
      this.processQueue().catch(console.error);
    }, delay);
  }

  private async processQueue() {
    if (!this.canProcessSharedIntents()) return;
    if (this.processQueueInFlight) {
      this.processQueueAgain = true;
      return;
    }
    this.processQueueInFlight = true;
    try {
      await KeptShareIntents.processQueue();
    } catch (error) {
      console.warn('Could not process Kept share intents queue', error);
    } finally {
      this.processQueueInFlight = false;
      if (this.processQueueAgain) {
        this.processQueueAgain = false;
        this.requestProcessQueue(250);
      }
    }
  }

  private async handleIntent(intent: ShareIntent) {
    if (!intent?.intentId || !this.canProcessSharedIntents()) return;
    if (this.processingIntentIds.has(intent.intentId)) return;
    this.processingIntentIds.add(intent.intentId);

    try {
      await this.createNoteFromIntent(intent);
      await KeptShareIntents.markProcessed({ intentId: intent.intentId });
      this.clearPendingNoteId(intent.intentId);
      this.showMessage('Added to Kept');
    } catch (error) {
      console.warn('Could not add shared item to Kept', error);
      this.showMessage('Could not add shared item to Kept');
    } finally {
      this.processingIntentIds.delete(intent.intentId);
    }
  }

  private async createNoteFromIntent(intent: ShareIntent) {
    const fileRefs = this.fileReferencesForIntent(intent);
    const body = this.intentBody(intent);
    const imageRefs = fileRefs.filter(file => this.isImageFile(file));
    const attachmentRefs = fileRefs.filter(file => !this.isImageFile(file));

    if (imageRefs.length && !navigator.onLine && !this.notes.isKept2LocalFirstActive()) {
      throw new Error('Image shares require a connection so images can be uploaded.');
    }

    const images = await Promise.all(imageRefs.map(file => this.fileRefToNoteImage(file)));
    let noteId = attachmentRefs.length ? this.pendingNoteId(intent.intentId) : null;

    if (noteId) {
      await this.notes.get(noteId, { merge: false }).catch(() => {
        this.clearPendingNoteId(intent.intentId);
        noteId = null;
      });
    }

    if (!noteId) {
      noteId = await this.notes.add(this.noteForIntent(intent, body, images));
      if (!noteId || noteId === -1) throw new Error('Note could not be created.');
      if (attachmentRefs.length) this.savePendingNoteId(intent.intentId, noteId);
    }

    for (const fileRef of attachmentRefs) {
      const file = await this.fileFromReference(fileRef);
      await this.notes.uploadAttachment(noteId, file);
    }

    await this.notes.load(undefined, { cacheBust: true });
  }

  private noteForIntent(intent: ShareIntent, body: string, images: NoteImageI[]): NoteI {
    const fallbackTitle = this.fallbackTitle(intent);
    return {
      noteTitle: body ? '' : fallbackTitle,
      noteBody: body,
      pinned: false,
      bgColor: '',
      bgImage: '',
      checkBoxes: [],
      images,
      isCbox: false,
      labels: [],
      archived: false,
      trashed: false
    };
  }

  private intentBody(intent: ShareIntent) {
    const parts = [intent.content, intent.url]
      .map(value => String(value || '').trim())
      .filter(value => !this.isLocalFileUrl(value))
      .filter(Boolean);
    return this.escapeHtml([...new Set(parts)].join('\n\n')).replace(/\n/g, '<br>');
  }

  private fallbackTitle(intent: ShareIntent) {
    const firstFile = intent.fileReferences?.[0]?.filename?.trim();
    if (firstFile) return firstFile;
    const localFile = this.filenameFromLocalFileUrl(intent.url);
    if (localFile) return localFile;
    if (intent.sourceType === 'image') return 'Shared image';
    if (intent.sourceType === 'file') return 'Shared file';
    return 'Shared note';
  }

  private async fileRefToNoteImage(fileRef: ShareFileReference): Promise<NoteImageI> {
    const file = await this.fileFromReference(fileRef);
    const uploaded = await this.notes.uploadImage(file);
    return {
      id: fileRef.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      dataUrl: uploaded.url,
      name: uploaded.name || file.name,
      placement: 'top'
    };
  }

  private async fileFromReference(fileRef: ShareFileReference) {
    const url = fileRef.directUrl
      ? fileRef.directUrl
      : (await KeptShareIntents.getFileURL({ relativePath: fileRef.pathInContainer })).url;
    const response = await this.fetchSharedFile(url);
    if (!response.ok) throw new Error(`Could not read shared file: ${fileRef.filename || fileRef.pathInContainer}`);
    const blob = await response.blob();
    const filename = this.safeFilename(fileRef.filename || this.filenameFromLocalFileUrl(fileRef.directUrl) || fileRef.pathInContainer || 'shared-file');
    return new File([blob], filename, {
      type: fileRef.mimeType || blob.type || 'application/octet-stream',
      lastModified: Date.now()
    });
  }

  private async fetchSharedFile(url: string) {
    try {
      return await fetch(url);
    } catch (originalError) {
      const convertedUrl = Capacitor.convertFileSrc(url);
      if (!convertedUrl || convertedUrl === url) throw originalError;
      return await fetch(convertedUrl);
    }
  }

  private isImageFile(fileRef: ShareFileReference) {
    const mime = String(fileRef.mimeType || '').toLowerCase();
    if (mime) return mime.startsWith('image/');
    return /\.(avif|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(fileRef.filename || fileRef.pathInContainer || '');
  }

  private fileReferencesForIntent(intent: ShareIntent) {
    const refs = intent.fileReferences || [];
    if (refs.length || !this.isLocalFileUrl(intent.url)) return refs;
    const filename = this.filenameFromLocalFileUrl(intent.url) || 'shared-file';
    return [{
      id: intent.intentId,
      filename,
      pathInContainer: filename,
      directUrl: String(intent.url),
      mimeType: this.mimeTypeFromFilename(filename)
    }];
  }

  private isLocalFileUrl(value?: string | null) {
    return /^file:\/\//i.test(String(value || '').trim());
  }

  private filenameFromLocalFileUrl(value?: string | null) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      return decodeURIComponent(url.pathname.split('/').pop() || '').trim();
    } catch {
      return decodeURIComponent(raw.split(/[\\/]/).pop() || '').trim();
    }
  }

  private mimeTypeFromFilename(filename: string) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const types: Record<string, string> = {
      csv: 'text/csv',
      gif: 'image/gif',
      heic: 'image/heic',
      heif: 'image/heif',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      json: 'application/json',
      md: 'text/markdown',
      pdf: 'application/pdf',
      png: 'image/png',
      svg: 'image/svg+xml',
      txt: 'text/plain',
      webp: 'image/webp',
      zip: 'application/zip'
    };
    return types[ext] || 'application/octet-stream';
  }

  private safeFilename(name: string) {
    return String(name || 'shared-file').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 180) || 'shared-file';
  }

  private pendingNoteId(intentId: string) {
    try {
      const value = localStorage.getItem(`${this.pendingNoteKeyPrefix}${intentId}`);
      const id = Number(value || 0);
      return Number.isFinite(id) && id !== 0 ? id : null;
    } catch {
      return null;
    }
  }

  private savePendingNoteId(intentId: string, noteId: number) {
    try { localStorage.setItem(`${this.pendingNoteKeyPrefix}${intentId}`, String(noteId)); } catch {}
  }

  private clearPendingNoteId(intentId: string) {
    try { localStorage.removeItem(`${this.pendingNoteKeyPrefix}${intentId}`); } catch {}
  }

  private escapeHtml(value: string) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  private showMessage(text: string) {
    try {
      (window as any).Snackbar?.show({ pos: 'bottom-left', text, duration: 3200 });
    } catch {}
  }

  private canProcessSharedIntents() {
    return !!this.auth.currentUser?.token || this.notes.isKept2LocalFirstActive();
  }
}
