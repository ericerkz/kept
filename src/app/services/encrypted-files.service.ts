import { Injectable } from '@angular/core';
import { uiText } from 'src/app/i18n/messages';
import { NoteAttachmentI, NoteI, UpdateKeyI } from '../interfaces/notes';
import { createNoteHtmlContainer, sanitizeNoteHtml } from '../utils/note-html';
import { prepareNoteImage } from '../utils/note-images';
import {
  ENCRYPTED_FILE_NAME, ENCRYPTED_FILE_PREFIX, EncryptedFileMeta, NoteSecretContent, encryptedFileId, encryptedFileRefs,
  encryptedFileUrl, openFile, sealFile
} from '../utils/note-crypto';
import { AuthService } from './auth.service';
import { NoteLockService } from './note-lock.service';
import { NotesService } from './notes.service';

// Images and attachments of encrypted notes (issue #27). Each file is
// encrypted with the note's key and stored as an `encrypted.keptenc`
// attachment, so it travels through the normal upload, offline queue and
// sync. The decrypted name, type and size live inside the note's encrypted
// content; decrypted bytes exist only in memory while the note is open.

export type FileUrlMapping = Map<string, string>;
export interface LockChange { fields: UpdateKeyI; mapping: FileUrlMapping }

const STORED_IMAGE = /^\/(?:api\/uploads\/images|__kept_local_media)\//;
const isEncryptedRow = (row: NoteAttachmentI) => /\.keptenc$/i.test(row.originalName || '');

@Injectable({ providedIn: 'root' })
export class EncryptedFilesService {
  constructor(private noteLock: NoteLockService, private notes: NotesService, private auth: AuthService) {}

  // Decrypts the images an encrypted note shows so the editor can display
  // them. Call with the stored note (its attachment rows) after unlocking.
  async prepare(note: NoteI) {
    this.noteLock.rememberRows(note);
    const content = this.noteLock.content(note), key = this.noteLock.dataKey(note);
    if (!content || !key) return;
    const ids = encryptedFileRefs(content).filter(id => content.files?.[id]?.kind !== 'attachment');
    await Promise.all(ids.map(async id => {
      const url = encryptedFileUrl(id);
      if (this.auth.hasDecryptedMedia(url)) return;
      try {
        const sealed = await this.notes.fetchAttachmentBlob(this.row(note, id));
        this.auth.registerDecryptedMedia(url, await openFile(key, sealed, content.files?.[id]?.type || ''));
      } catch (error) {
        console.warn('Could not decrypt an image of this note.', error);
      }
    }));
  }

  // Encrypts and uploads an image added to an encrypted note. Returns its
  // kept://file/ reference, already displayable.
  async uploadImage(note: NoteI, file: File): Promise<{ url: string; name: string }> {
    const key = this.requireKey(note);
    const prepared = await prepareNoteImage(file, file.name);
    const row = await this.uploadSealed(note, key, prepared.blob);
    this.noteLock.recordFile(note, row.syncId!, { name: prepared.name, type: prepared.blob.type, size: prepared.blob.size, kind: 'image' });
    const url = encryptedFileUrl(row.syncId!);
    this.auth.registerDecryptedMedia(url, prepared.blob);
    return { url, name: prepared.name };
  }

  async uploadAttachment(note: NoteI, file: File): Promise<NoteAttachmentI> {
    const key = this.requireKey(note);
    const row = await this.uploadSealed(note, key, file);
    const type = file.type || 'application/octet-stream';
    this.noteLock.recordFile(note, row.syncId!, { name: file.name, type, size: file.size, kind: 'attachment' });
    await this.persistFiles(note);
    return { id: row.id, syncId: row.syncId, noteId: note.id, originalName: file.name, fileSize: file.size,
      mimeType: type, uploadedAt: row.uploadedAt, encrypted: true };
  }

  async deleteAttachment(note: NoteI, view: NoteAttachmentI) {
    const row = view.syncId ? this.noteLock.attachmentRow(note, view.syncId) : null;
    const restore = this.noteLock.checkpoint(note);
    try {
      if (view.syncId) this.noteLock.forgetFile(note, view.syncId);
      await this.persistFiles(note);
    } catch (error) { restore(); throw error; }
    if (row?.id) await this.notes.deleteAttachment(note.id!, row.id);
  }

  // Seals the current content (with its file list) so the stored note
  // refers to a newly added file at once; otherwise the server would later
  // treat the upload as unused and remove it.
  private async persistFiles(note: NoteI) {
    const content = this.noteLock.content(note);
    if (content) await this.notes.updateKey({ checkBoxes: content.checkBoxes as NoteI['checkBoxes'] }, note.id!);
  }

  async download(note: NoteI, view: NoteAttachmentI) {
    const key = this.requireKey(note);
    const sealed = await this.notes.fetchAttachmentBlob(this.row(note, view.syncId!));
    const plain = await openFile(key, sealed, view.mimeType);
    await this.notes.saveBlob(plain, view.originalName || 'attachment', view.mimeType);
  }

  // Locks a note with encryption, including its images and attachments.
  // `note` must be the full note. `content` overrides the note's saved
  // content (the editor passes what it shows, including unsaved edits).
  // The mapping says which old image URLs now have encrypted references.
  async lock(note: NoteI, content?: NoteSecretContent): Promise<LockChange | null> {
    await this.notes.requireEncryptionSupport(note);
    const fields = await this.noteLock.createLockFields(note, content);
    if (!fields) return null;
    try {
      const migrated = await this.encryptFiles(note, this.noteLock.content(note)!);
      this.noteLock.setContent(note, migrated.content);
      await this.notes.updateKey(fields, note.id!);
      await this.notes.retirePlaintextImageCache(note, [...migrated.mapping.keys()]);
      await this.retireRows(note, migrated.replaced, fields.lockSalt!);
      return { fields, mapping: migrated.mapping };
    } catch (error) {
      this.noteLock.clearUnlocked(note);
      throw error;
    }
  }

  // Finishes an interrupted lock: any unencrypted attachment still on an
  // encrypted note is encrypted and the original removed.
  async finishMigration(note: NoteI) {
    const leftovers = (note.attachments || []).filter(row => !row.encrypted && !isEncryptedRow(row));
    const content = this.noteLock.content(note);
    if (!leftovers.length || !content) return;
    const migrated = await this.encryptFiles({ ...note, attachments: leftovers }, content);
    this.noteLock.setContent(note, migrated.content);
    await this.notes.updateKey({ checkBoxes: migrated.content.checkBoxes as NoteI['checkBoxes'] }, note.id!);
    await this.retireRows(note, migrated.replaced, note.lockSalt!);
  }

  // A new passcode gives the note a new key: every file is re-encrypted
  // with it and the content re-sealed, then the old encrypted files are
  // removed. Someone who knew the old passcode can't read what follows.
  async changePasscode(note: NoteI): Promise<LockChange | null> {
    if (!this.noteLock.isEncrypted(note)) {
      if (!await this.noteLock.ensureUnlocked(note)) return null;
      return this.lock(note);
    }
    const keys = await this.noteLock.prepareKeyRotation(note);
    if (!keys) return null;
    this.noteLock.rememberRows(note);
    // Nothing changes until every file is re-encrypted; a failure leaves the
    // note on its old key (new uploads are cleaned up as unused).
    const restore = this.noteLock.checkpoint(note);
    try {
      const rekeyed = await this.reencryptFiles(note, keys.dataKey);
      const fields = this.noteLock.rotateKeys(note, keys, rekeyed.content);
      await this.notes.updateKey(fields, note.id!);
      await this.retireRows(note, rekeyed.replaced, fields.lockSalt!);
      return { fields, mapping: rekeyed.mapping };
    } catch (error) {
      restore();
      throw error;
    }
  }

  private async reencryptFiles(note: NoteI, newKey: CryptoKey) {
    const oldKey = this.requireKey(note);
    const content = this.noteLock.content(note)!;
    const mapping: FileUrlMapping = new Map();
    const files: Record<string, EncryptedFileMeta> = {};
    const replaced: NoteAttachmentI[] = [];
    const ids = new Set([...encryptedFileRefs(content), ...Object.keys(content.files || {})]);
    for (const id of ids) {
      const meta = content.files?.[id] || { name: 'file', type: '', size: 0, kind: 'image' as const };
      const plain = await openFile(oldKey, await this.notes.fetchAttachmentBlob(this.row(note, id)), meta.type);
      const stored = await this.uploadSealed(note, newKey, plain);
      files[stored.syncId!] = meta;
      const newRef = encryptedFileUrl(stored.syncId!);
      mapping.set(encryptedFileUrl(id), newRef);
      if (meta.kind === 'image') this.auth.registerDecryptedMedia(newRef, plain);
      const oldRow = this.noteLock.attachmentRow(note, id);
      if (oldRow) replaced.push(oldRow);
    }
    const remap = (url: string) => mapping.get(this.auth.canonicalImageUrl(url)) || url;
    const images = ((content.images || []) as Array<{ dataUrl: string }>).map(image => ({ ...image, dataUrl: remap(image.dataUrl) }));
    const noteBody = await this.replaceImages(content.noteBody, async src => remap(src));
    return { content: { ...content, noteBody, images, files } as NoteSecretContent, mapping, replaced };
  }

  // Removes the lock: every file is decrypted and uploaded again
  // unencrypted, then the content is saved in the clear.
  async removeLock(note: NoteI): Promise<LockChange | null> {
    if (!this.noteLock.isEncrypted(note)) {
      const fields = await this.noteLock.removeLockFields(note);
      if (!fields) return null;
      await this.notes.updateKey(fields, note.id!);
      this.noteLock.clearUnlocked(note);
      return { fields, mapping: new Map() };
    }
    if (!await this.noteLock.ensureUnlocked(note)) return null;
    this.noteLock.rememberRows(note);
    const plain = await this.decryptFiles(note);
    const encryptedRows = this.noteLock.attachmentRows(note).filter(isEncryptedRow);
    const fields = await this.noteLock.removeLockFields(note, plain.content);
    if (!fields) return null;
    // Never clear the envelope or key until all restored files and the note
    // have committed together. Connected libraries use one server transaction;
    // device-only libraries use one IndexedDB transaction.
    await this.notes.removeEncryptedLock(note, fields, plain.attachments);
    await this.deleteRows(note, encryptedRows);
    this.noteLock.clearUnlocked(note);
    return { fields, mapping: plain.mapping };
  }

  private async encryptFiles(note: NoteI, content: NoteSecretContent) {
    const key = this.requireKey(note);
    const mapping: FileUrlMapping = new Map();
    const files = { ...(content.files || {}) };
    const encryptImage = async (url: string, name: string) => {
      const canonical = this.auth.canonicalImageUrl(url);
      // Inline data URLs (drawings) are sealed with the content; external
      // images aren't stored files; encrypted ones are done.
      if (!STORED_IMAGE.test(canonical)) return canonical;
      if (mapping.has(canonical)) return mapping.get(canonical)!;
      const plain = await this.notes.fetchImageBlob(canonical);
      const row = await this.uploadSealed(note, key, plain);
      files[row.syncId!] = { name: name || 'image', type: plain.type, size: plain.size, kind: 'image' };
      const ref = encryptedFileUrl(row.syncId!);
      this.auth.registerDecryptedMedia(ref, plain);
      mapping.set(canonical, ref);
      return ref;
    };
    const images = [];
    for (const image of (content.images || []) as Array<{ dataUrl: string; name?: string }>) {
      images.push({ ...image, dataUrl: await encryptImage(image.dataUrl, image.name || 'image') });
    }
    const noteBody = await this.replaceImages(content.noteBody, (src, alt) => encryptImage(src, alt));
    const replaced: NoteAttachmentI[] = [];
    for (const row of (note.attachments || []).filter(row => !row.encrypted && !isEncryptedRow(row))) {
      const plain = await this.notes.fetchAttachmentBlob(row);
      const stored = await this.uploadSealed(note, key, plain);
      files[stored.syncId!] = { name: row.originalName, type: row.mimeType, size: row.fileSize, kind: 'attachment' };
      replaced.push(row);
    }
    return { content: { ...content, noteBody, images, files }, mapping, replaced };
  }

  private async decryptFiles(note: NoteI) {
    const key = this.requireKey(note);
    const content = this.noteLock.content(note)!;
    const mapping: FileUrlMapping = new Map();
    const open = async (id: string) => {
      const meta = content.files?.[id];
      const plain = await openFile(key, await this.notes.fetchAttachmentBlob(this.row(note, id)), meta?.type || '');
      return { plain, name: meta?.name || 'file', type: meta?.type || plain.type };
    };
    const decryptImage = async (url: string) => {
      const ref = this.auth.canonicalImageUrl(url);
      const id = encryptedFileId(ref);
      if (!id) return ref;
      if (mapping.has(ref)) return mapping.get(ref)!;
      const { plain, name, type } = await open(id);
      const uploaded = await this.notes.uploadImage(new File([plain], name, { type }));
      const canonical = this.auth.canonicalImageUrl(uploaded.url);
      mapping.set(ref, canonical);
      return canonical;
    };
    const images = [];
    for (const image of (content.images || []) as Array<{ dataUrl: string }>) images.push({ ...image, dataUrl: await decryptImage(image.dataUrl) });
    const noteBody = await this.replaceImages(content.noteBody, src => decryptImage(src));
    const attachments: Array<{ sourceSyncId: string; file: File }> = [];
    for (const [id, meta] of Object.entries(content.files || {})) {
      if (meta.kind !== 'attachment') continue;
      const { plain, name, type } = await open(id);
      attachments.push({ sourceSyncId: id, file: new File([plain], name, { type }) });
    }
    return { content: { noteBody, checkBoxes: content.checkBoxes, images, files: {} } as NoteSecretContent, mapping, attachments };
  }

  private async replaceImages(html: string, replace: (src: string, alt: string) => Promise<string>) {
    const container = createNoteHtmlContainer();
    container.innerHTML = sanitizeNoteHtml(html || '');
    for (const img of Array.from(container.querySelectorAll<HTMLImageElement>('img[src]'))) {
      img.setAttribute('src', await replace(img.getAttribute('src') || '', img.getAttribute('alt') || 'image'));
    }
    return container.innerHTML;
  }

  private async uploadSealed(note: NoteI, key: CryptoKey, file: Blob) {
    const row = await this.notes.uploadAttachment(note.id!, await sealFile(key, file), ENCRYPTED_FILE_NAME);
    this.noteLock.rememberRow(note, row);
    return row;
  }

  private async retireRows(note: NoteI, rows: NoteAttachmentI[], salt: string) {
    if (!rows.length) return;
    try {
      // A durable local edit is not a server acknowledgement. On quota or
      // network failure keep the previous files too; finishMigration/server
      // cleanup can remove them once the encrypted replacement is confirmed.
      await this.notes.confirmEncryptedReplacement(note, salt);
    } catch (error) {
      console.warn('Kept previous file copies until encryption finishes syncing.', error);
      return;
    }
    await this.deleteRows(note, rows);
  }

  private async deleteRows(note: NoteI, rows: NoteAttachmentI[]) {
    for (const row of rows) {
      try { await this.notes.deleteAttachment(note.id!, row.id); }
      catch (error) { console.warn('Could not remove a replaced attachment; it will be retried.', error); }
    }
  }

  private row(note: NoteI, syncId: string): Pick<NoteAttachmentI, 'id' | 'syncId'> {
    return this.noteLock.attachmentRow(note, syncId) || { id: 0, syncId };
  }

  private requireKey(note: NoteI) {
    const key = this.noteLock.dataKey(note);
    if (!key) throw new Error(uiText('note_lock.unlock_to_save'));
    return key;
  }
}

export { ENCRYPTED_FILE_PREFIX };
