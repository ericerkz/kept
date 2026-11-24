import { uiText } from 'src/app/i18n/messages';
import { OfflineSyncService } from './offline-sync.service';
import { Injectable } from '@angular/core';
import { WorkspaceService } from './workspace.service';
import { AuthService } from './auth.service';
import { CheckboxI, NoteAttachmentI, NoteI, NoteImageI, UpdateKeyI } from '../interfaces/notes';
import {
  E2E_LOCK_MARKER, EncryptedFileMeta, NOTE_KDF_ITERATIONS, NoteKeys, NoteSecretContent, StoredLinkPreview, canonicalLinkUrl, createNoteKeys,
  openNoteContent, parseNoteEnvelope, sealNoteContent, unlockNoteKeys, withoutTrailingPunctuation
} from '../utils/note-crypto';

// An unlocked encrypted note: its keys and decrypted content, in memory only.
// Keys are never written to storage, so a reload asks for the passcode again.
interface UnlockedNote {
  keys: NoteKeys;
  // The note's full decrypted content.
  content?: NoteSecretContent;
  // The envelope this content came from or was last sealed into.
  envelope?: string;
  // Stored attachment rows of the note, by sync ID: editors only see
  // decrypted views, but fetching or deleting a file needs its row.
  rows?: Map<string, NoteAttachmentI>;
  expiresAt: number;
}

// The content a note's overview card shows (NoteLockService.cardContent).
export interface NoteCardContent {
  noteBody: string;
  checkBoxes: CheckboxI[];
  images: NoteImageI[];
  attachments: NoteAttachmentI[];
}

@Injectable({
  providedIn: 'root'
})
export class NoteLockService {
  constructor(private workspace: WorkspaceService, private sync: OfflineSyncService, private auth: AuthService) {}
  private readonly unlockPrefix = 'kept_unlocked_note:';
  private readonly unlockMs = 5 * 60 * 1000;
  private readonly unlocked = new Map<string, UnlockedNote>();
  // Card views of unlocked encrypted notes, rebuilt when their content changes.
  private readonly cardViews = new WeakMap<NoteI, { content: NoteSecretContent; rows?: NoteAttachmentI[]; view: NoteCardContent }>();

  isLocked(note?: NoteI | null) {
    return !!(note?.locked && note.lockSalt && note.lockHash);
  }

  // Locked with end-to-end encryption (issue #27) rather than a passcode hash.
  isEncrypted(note?: NoteI | null) {
    return this.isLocked(note) && note!.lockHash === E2E_LOCK_MARKER;
  }

  isUnlocked(note?: NoteI | null) {
    if (!this.isLocked(note)) return true;
    const key = this.noteKey(note!);
    if (!key) return false;
    if (this.isEncrypted(note)) return !!this.session(note!, { fresh: true });
    try {
      const expiresAt = Number(sessionStorage.getItem(this.unlockPrefix + key) || 0);
      if (expiresAt > Date.now()) return true;
      sessionStorage.removeItem(this.unlockPrefix + key);
    } catch {}
    return false;
  }

  // A locked note's card shows its content only while the note is unlocked
  // here. An encrypted note's card is drawn from its decrypted content
  // (cardContent), which exists only in memory.
  lockPreviewHidden(note?: NoteI | null) {
    if (!this.isLocked(note)) return false;
    if (this.isEncrypted(note)) return !this.session(note!, { fresh: true })?.content;
    return !this.isUnlocked(note);
  }

  // When this device's unlock of the note runs out; 0 if it isn't unlocked.
  unlockExpiresAt(note?: NoteI | null): number {
    if (!this.isLocked(note) || !this.isUnlocked(note)) return 0;
    if (this.isEncrypted(note)) return this.session(note!, { fresh: true })?.expiresAt || 0;
    try { return Number(sessionStorage.getItem(this.unlockPrefix + this.noteKey(note!)) || 0); } catch { return 0; }
  }

  // What the note's overview card shows: an encrypted note's decrypted
  // content while it is unlocked here (as of unlocking or the last save on
  // this device), otherwise the note's own fields. The decrypted copy is
  // never assigned to the note, so it can't be saved or cached by mistake.
  cardContent(note: NoteI): NoteCardContent {
    const content = this.isEncrypted(note) ? this.session(note, { fresh: true })?.content : undefined;
    if (!content) return { noteBody: note.noteBody || '', checkBoxes: note.checkBoxes || [], images: note.images || [], attachments: note.attachments || [] };
    const cached = this.cardViews.get(note);
    if (cached?.content === content && cached.rows === note.attachments) return cached.view;
    // Copies: the editor may change the unlocked content in place before
    // saving, and the card shows what is saved.
    const view: NoteCardContent = {
      noteBody: content.noteBody || '',
      checkBoxes: ((content.checkBoxes || []) as CheckboxI[]).map(item => ({ ...item })),
      images: ((content.images || []) as NoteImageI[]).map(image => ({ ...image })),
      attachments: this.attachmentViews(note)
    };
    this.cardViews.set(note, { content, rows: note.attachments, view });
    return view;
  }

  // The preview an encrypted note kept for this link from before it was
  // locked; null if it has none (its card then shows the link's domain).
  storedLinkPreview(note: NoteI | null | undefined, url: string): StoredLinkPreview | null {
    if (!note || !this.isEncrypted(note)) return null;
    const previews = this.session(note)?.content?.linkPreviews;
    if (!previews) return null;
    const key = canonicalLinkUrl(url);
    if (previews[key]) return previews[key];
    // Previews are kept under a link's complete address, but cards ask for
    // a link without its trailing punctuation (a final ")" included).
    const trimmed = withoutTrailingPunctuation(key);
    return Object.values(previews).find(preview => withoutTrailingPunctuation(preview.url) === trimmed) || null;
  }

  async ensureUnlocked(note: NoteI) {
    if (!this.isLocked(note) || this.isUnlocked(note)) return true;
    const passcode = window.prompt(uiText('note_lock.enter_this_note_s_passcode'));
    if (!passcode) return false;
    if (this.isEncrypted(note)) {
      if (!globalThis.crypto?.subtle) {
        window.alert(uiText('note_lock.secure_context_required'));
        return false;
      }
      if (!parseNoteEnvelope(note.encryptedContent)) {
        window.alert(uiText('note_lock.encrypted_content_unreadable'));
        return false;
      }
      try {
        const keys = await unlockNoteKeys(passcode, note.encryptedContent!);
        const content = await openNoteContent(keys, note.encryptedContent!);
        this.remember(note, { keys, content, envelope: note.encryptedContent });
      } catch {
        window.alert(uiText('note_lock.incorrect_passcode'));
        return false;
      }
      this.markUnlocked(note);
      return true;
    }
    const ok = await this.verify(note, passcode);
    if (!ok) {
      window.alert(uiText('note_lock.incorrect_passcode'));
      return false;
    }
    this.markUnlocked(note);
    // Opening an existing lock must not silently change its storage format:
    // other installed bundles may still use the legacy lock. Encryption is
    // enabled explicitly when creating a lock or changing its passcode.
    return true;
  }

  // A copy of the note with its decrypted content, for the editor.
  withPlaintext(note: NoteI): NoteI {
    if (!this.isEncrypted(note)) return note;
    const content = this.session(note)?.content;
    if (!content) return note;
    this.rememberRows(note);
    return {
      ...note,
      noteBody: content.noteBody,
      checkBoxes: content.checkBoxes as NoteI['checkBoxes'],
      images: (content.images || []) as NoteI['images'],
      attachments: this.attachmentViews(note)
    };
  }

  // A collaborator's or another device's version of an encrypted note,
  // decrypted for an open editor. Null when it can't be decrypted here (a
  // card preview without the envelope, or the note was locked again).
  async openExternal(note: NoteI): Promise<NoteI | null> {
    if (!this.isEncrypted(note)) return note;
    const session = this.session(note);
    if (!session || !note.encryptedContent) return null;
    if (note.encryptedContent !== session.envelope) {
      try {
        session.content = await openNoteContent(session.keys, note.encryptedContent);
        session.envelope = note.encryptedContent;
      } catch { return null; }
    }
    return this.withPlaintext(note);
  }

  // Decrypted views of the note's encrypted attachments, with the stored
  // attachment row's ID where the row is known here.
  attachmentViews(note: NoteI): NoteAttachmentI[] {
    const files = this.session(note)?.content?.files || {};
    const rows = new Map([...(this.session(note)?.rows || new Map()).entries(),
      ...(note.attachments || []).filter(row => !row.encrypted).map(row => [row.syncId, row] as const)]);
    return Object.entries(files).filter(([, meta]) => meta.kind === 'attachment').map(([syncId, meta]) => ({
      id: rows.get(syncId)?.id ?? 0,
      syncId,
      noteId: note.id,
      originalName: meta.name,
      fileSize: meta.size,
      mimeType: meta.type,
      uploadedAt: rows.get(syncId)?.uploadedAt || '',
      encrypted: true
    }));
  }

  // Remembers the note's stored attachment rows (not decrypted views).
  rememberRows(note: NoteI) {
    for (const row of note.attachments || []) if (!row.encrypted) this.rememberRow(note, row);
  }

  rememberRow(note: NoteI, row: NoteAttachmentI) {
    const session = this.session(note);
    if (!session || !row?.syncId) return;
    (session.rows ||= new Map()).set(row.syncId, row);
  }

  attachmentRow(note: NoteI, syncId: string): NoteAttachmentI | null {
    return this.session(note)?.rows?.get(syncId) || null;
  }

  attachmentRows(note: NoteI): NoteAttachmentI[] {
    return [...(this.session(note)?.rows?.values() || [])];
  }

  content(note: NoteI): NoteSecretContent | null {
    return this.session(note)?.content || null;
  }

  setContent(note: NoteI, content: NoteSecretContent) {
    const session = this.session(note);
    if (!session) throw new Error(uiText('note_lock.unlock_to_save'));
    session.content = content;
  }

  dataKey(note: NoteI): CryptoKey | null {
    return this.session(note)?.keys.dataKey || null;
  }

  recordFile(note: NoteI, syncId: string, meta: EncryptedFileMeta) {
    const session = this.session(note);
    if (!session?.content) throw new Error(uiText('note_lock.unlock_to_save'));
    session.content = { ...session.content, files: { ...(session.content.files || {}), [syncId]: meta } };
  }

  forgetFile(note: NoteI, syncId: string) {
    const session = this.session(note);
    if (!session?.content?.files) return;
    const { [syncId]: _removed, ...files } = session.content.files;
    session.content = { ...session.content, files };
  }

  // Locks with encryption under a new random note key. The content is sealed
  // when the fields are saved (NotesService calls sealOutgoing). Pass the
  // full note, not a card preview.
  async createLockFields(note?: NoteI | null, content?: NoteSecretContent | null) {
    if (!globalThis.crypto?.subtle) throw new Error(uiText('note_lock.secure_context_required'));
    const resolved = content || (note ? this.plainContent(note) : null);
    if (note && !resolved) throw new Error(uiText('note_lock.open_the_note_to_lock_it'));
    const passcode = this.promptNewPasscode();
    if (!passcode) return null;
    const keys = await createNoteKeys(passcode);
    if (note) this.remember(note, { keys, content: resolved! });
    return {
      locked: true,
      lockSalt: keys.kdf.salt,
      lockHash: E2E_LOCK_MARKER
    } satisfies UpdateKeyI;
  }

  // Changing an encrypted note's passcode gives it a new key (next epoch),
  // so someone who knew the old passcode can't read later changes. The
  // caller re-encrypts the files with it, then switches over (rotateKeys).
  async prepareKeyRotation(note: NoteI): Promise<NoteKeys | null> {
    if (!this.isEncrypted(note) || !await this.ensureUnlocked(note)) return null;
    const session = this.session(note);
    if (!session?.content) return null;
    const passcode = this.promptNewPasscode();
    if (!passcode) return null;
    return createNoteKeys(passcode, NOTE_KDF_ITERATIONS, (session.keys.epoch || 1) + 1);
  }

  // Switches the unlocked note to its rotated key and the content that
  // refers to the re-encrypted files. Saving the returned fields seals it.
  rotateKeys(note: NoteI, keys: NoteKeys, content: NoteSecretContent): UpdateKeyI {
    const session = this.session(note);
    if (!session) throw new Error(uiText('note_lock.unlock_to_save'));
    session.keys = keys;
    session.content = content;
    return { locked: true, lockSalt: keys.kdf.salt, lockHash: E2E_LOCK_MARKER };
  }

  // The stored note was sealed with a different key than the one unlocked
  // here: its passcode was changed elsewhere.
  keyChanged(note: NoteI): boolean {
    const session = this.session(note);
    const envelope = parseNoteEnvelope(note.encryptedContent);
    return !!(session && envelope && (envelope.epoch !== (session.keys.epoch || 1) || envelope.kdf.salt !== session.keys.kdf.salt));
  }

  // Removing the lock stores the content in the clear again. For an
  // encrypted note, `plainContent` is its content with every file already
  // re-uploaded unencrypted (EncryptedFilesService.removeLock). A legacy
  // lock's content is already readable on the server, so only the lock
  // fields are sent (a card preview's body is truncated).
  async removeLockFields(note: NoteI, plainContent?: NoteSecretContent) {
    const unlocked = await this.ensureUnlocked(note);
    if (!unlocked) return null;
    const content = this.isEncrypted(note) ? plainContent : null;
    if (this.isEncrypted(note) && !content) return null;
    // Preparing fields is not a commit. A failed restore must retain the
    // original key/content so the user can retry without losing any files.
    const fields: UpdateKeyI = { locked: false, lockSalt: '', lockHash: '' };
    if (content) Object.assign(fields, { encryptedContent: '', noteBody: content.noteBody, checkBoxes: content.checkBoxes, images: content.images || [] });
    return fields;
  }

  checkpoint(note: NoteI): () => void {
    const key = this.noteKey(note);
    const current = key ? this.unlocked.get(key) : undefined;
    const snapshot = current ? { ...current, rows: current.rows ? new Map(current.rows) : undefined } : undefined;
    return () => {
      if (!key) return;
      if (snapshot) this.unlocked.set(key, snapshot);
      else this.clearUnlocked(note);
    };
  }

  // Applied to every note write (NotesService.update/updateKey). For a note
  // that is, or is becoming, encrypted: replaces plaintext content with a
  // fresh envelope. Metadata-only writes and already-sealed payloads pass
  // through unchanged. Throws if the content would have to be sealed but the
  // note isn't unlocked on this device.
  async sealOutgoing<T extends UpdateKeyI>(payload: T, current?: NoteI | null): Promise<T> {
    const merged = { ...(current || {}), ...payload } as NoteI;
    if (!this.isEncrypted(merged)) return payload;
    const wasEncrypted = this.isEncrypted(current);
    const becomingEncrypted = !wasEncrypted || (payload.lockSalt !== undefined && payload.lockSalt !== current?.lockSalt);
    const carriesContent = payload.noteBody !== undefined || payload.checkBoxes !== undefined || payload.images !== undefined;
    const alreadySealed = !!payload.encryptedContent && payload.encryptedContent !== current?.encryptedContent;
    if (alreadySealed || (!carriesContent && !becomingEncrypted)) return payload;
    const session = this.session(merged);
    if (!session) throw new Error(uiText('note_lock.unlock_to_save'));
    // A partial write keeps the rest of the content from the unlocked copy.
    const known = session.content;
    if ((payload.noteBody === undefined || payload.checkBoxes === undefined || payload.images === undefined) && !known) {
      throw new Error(uiText('note_lock.unlock_to_save'));
    }
    // Editors hold decrypted object URLs; store the kept://file/ references.
    const content: NoteSecretContent = {
      noteBody: payload.noteBody !== undefined ? this.auth.canonicalImageHtml(String(payload.noteBody ?? '')) : known!.noteBody,
      checkBoxes: payload.checkBoxes !== undefined ? (payload.checkBoxes || []) : known!.checkBoxes,
      images: payload.images !== undefined
        ? ((payload.images || []) as Array<{ dataUrl: string }>).map(image => ({ ...image, dataUrl: this.auth.canonicalImageUrl(image.dataUrl) }))
        : (known!.images || []),
      files: known?.files || {},
      // Kept for the links still in the body (see sealNoteContent).
      ...(known?.linkPreviews ? { linkPreviews: known.linkPreviews } : {})
    };
    const encryptedContent = await sealNoteContent(session.keys, content);
    // Never replace readable content with an envelope we can't open again.
    await openNoteContent(session.keys, encryptedContent);
    session.content = content;
    session.envelope = encryptedContent;
    // Decrypted attachment views stay in memory; the stored rows are untouched.
    const { attachments: _views, ...rest } = payload as T & { attachments?: unknown };
    return { ...rest, encryptedContent, noteBody: '', checkBoxes: [], images: [] } as unknown as T;
  }

  markUnlocked(note: NoteI) {
    const key = this.noteKey(note);
    if (!key) return;
    const session = this.unlocked.get(key);
    if (session) session.expiresAt = Date.now() + this.unlockMs;
    try { sessionStorage.setItem(this.unlockPrefix + key, String(Date.now() + this.unlockMs)); } catch {}
  }

  clearUnlocked(note: NoteI) {
    const key = this.noteKey(note);
    if (!key) return;
    this.unlocked.delete(key);
    try { sessionStorage.removeItem(this.unlockPrefix + key); } catch {}
  }

  private promptNewPasscode() {
    const passcode = window.prompt(uiText('note_lock.create_a_passcode_for_this_note'));
    if (!passcode) return null;
    const confirmPasscode = window.prompt(uiText('note_lock.re_enter_the_passcode'));
    if (passcode !== confirmPasscode) {
      window.alert(uiText('note_lock.those_passcodes_did_not_match'));
      return null;
    }
    return passcode;
  }

  private remember(note: NoteI, value: Omit<UnlockedNote, 'expiresAt'>) {
    const key = this.noteKey(note);
    if (key) this.unlocked.set(key, { ...value, expiresAt: Date.now() + this.unlockMs });
  }

  // `fresh` sessions are within the 5-minute window that lets a note be
  // reopened without its passcode. Saving doesn't need that: the key stays in
  // memory until the note is relocked, so an editor left open can still save.
  private session(note: NoteI, { fresh = false } = {}): UnlockedNote | null {
    const key = this.noteKey(note);
    const session = key ? this.unlocked.get(key) : undefined;
    if (!session) return null;
    if (fresh && session.expiresAt <= Date.now()) return null;
    return session;
  }

  // The note's full content, or null if it isn't known here: an encrypted
  // note that isn't unlocked, or a card preview (its body is truncated).
  private plainContent(note: NoteI): NoteSecretContent | null {
    if (this.isEncrypted(note)) return this.session(note)?.content || null;
    if (note.isCardPreview) return null;
    return { noteBody: note.noteBody || '', checkBoxes: note.checkBoxes || [], images: note.images || [], files: {} };
  }

  private async verify(note: NoteI, passcode: string) {
    if (!note.lockSalt || !note.lockHash) return false;
    return await this.hash(passcode, note.lockSalt) === note.lockHash;
  }

  private noteKey(note: NoteI) {
    const key = note.syncId || (note.id != null ? String(note.id) : '');
    return `${this.sync.partition}:${this.sync.generation || 'pending'}:${key}`;
  }

  // Legacy passcode verifier for locks made before encryption.
  private async hash(passcode: string, salt: string) {
    const encoder = new TextEncoder();
    try {
      const key = await crypto.subtle.importKey('raw', encoder.encode(passcode), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({
        name: 'PBKDF2',
        salt: encoder.encode(salt),
        iterations: 150000,
        hash: 'SHA-256'
      }, key, 256);
      return `pbkdf2:${this.base64Url(new Uint8Array(bits))}`;
    } catch {
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${passcode}`));
      return `sha256:${this.base64Url(new Uint8Array(digest))}`;
    }
  }

  private base64Url(bytes: Uint8Array) {
    let binary = '';
    bytes.forEach(byte => binary += String.fromCharCode(byte));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
}
