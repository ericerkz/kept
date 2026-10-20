import { Injectable } from '@angular/core';
import type { Reader } from '@zip.js/zip.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BehaviorSubject } from 'rxjs';
import { RESOURCE_STORES, ResourceType, Workspace, WorkspacePreferences } from '../interfaces/workspace';
import { sanitizeNoteHtml } from '../utils/note-html';
import { NativeWorkspaceService } from './native-workspace.service';
import { OfflineStoreService } from './offline-store.service';
import { WorkspaceService } from './workspace.service';

interface BackupEntry { path: string; kind: 'record' | 'blob'; type?: ResourceType; blobKey?: string; mimeType?: string; size: number; sha256: string; }
interface BackupManifest { format: 'kept'; version: 1; createdAt: string; preferences: WorkspacePreferences; entries: BackupEntry[]; }
const CHUNK = 256 * 1024;
const JSON_LIMIT = 64 * 1024 * 1024;
export const BACKUP_NOTICE = 'This backup includes readable note content, including passcode-locked notes. Backups are plain ZIP files. Store it somewhere private. Deleting the app may delete all notes kept on this device.';

function toBase64(bytes: Uint8Array) {
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
async function nativeFileReader(reference: string, size: number, readChunk: (offset: number,length: number)=>Promise<Uint8Array>) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid backup file size.');
  const {Reader} = await import('@zip.js/zip.js');
  return new class extends Reader<string> {
  override size: number;
  constructor() { super(reference); this.size = size; }
  override async readUint8Array(offset: number, length: number) {
    const result = new Uint8Array(Math.min(length, this.size - offset));
    for (let position = 0; position < result.length; position += CHUNK) {
      const bytes = await readChunk(offset + position, Math.min(CHUNK, result.length - position));
      if (!bytes.length || bytes.length > Math.min(CHUNK, result.length - position)) throw new Error('The selected file could not be read completely.');
      result.set(bytes, position);
      if (bytes.length !== Math.min(CHUNK, result.length - position)) throw new Error('The selected file was truncated.');
    }
    return result;
  }
  }();
}

@Injectable({ providedIn: 'root' })
export class WorkspaceBackupService {
  readonly progress$ = new BehaviorSubject('');
  private busy = false;
  private exportedRevision = -1;
  constructor(private store: OfflineStoreService, private workspaces: WorkspaceService, private native: NativeWorkspaceService) {}

  get reminderDue() {
    const workspace = this.workspaces.local;
    if (!workspace || workspace.backupRemindersDisabled || (workspace as any).lastBackupRevision === workspace.revision) return false;
    const last = Math.max(workspace.lastBackupAt || 0, workspace.backupReminderDismissedAt || 0);
    return Date.now() - (last || Date.parse(workspace.createdAt)) >= (last ? 30 : 7) * 86400000;
  }
  async dismissReminder(disable = false) {
    if (this.workspaces.local) await this.store.patchWorkspace(this.workspaces.local.id, { backupReminderDismissedAt: Date.now(), backupRemindersDisabled: disable });
    await this.workspaces.refresh();
  }

  async export() {
    await this.native.ready;
    if (!this.native.plugin || !this.native.capabilities$.value?.streamingFiles) throw new Error('Update the native Kept app to save a complete device backup.');
    if (!window.confirm(BACKUP_NOTICE)) return false;
    const plugin = this.native.plugin;
    const { reference } = await plugin.beginExport({ name: `kept-backup-${new Date().toISOString().slice(0, 10)}.zip`, mimeType: 'application/zip' });
    let offset = 0;
    try {
      await this.exportToStream(new WritableStream<Uint8Array>({ write: async chunk => {
        for (let i = 0; i < chunk.length; i += CHUNK) {
          const bytes = chunk.subarray(i, i + CHUNK);
          await plugin.writeExportChunk({ reference, offset, base64: toBase64(bytes) }); offset += bytes.length;
        }
      }}));
      await plugin.finishExport({ reference });
      if (this.workspaces.local) await this.store.patchWorkspace(this.workspaces.local.id, { lastBackupAt: Date.now(),lastBackupRevision:this.exportedRevision } as any);
      await this.workspaces.refresh();
      return true;
    } catch (error) { await plugin.abortExport({ reference }).catch(() => undefined); throw error; }
  }

  async exportToStream(output: WritableStream<Uint8Array>, source = this.workspaces.local) {
    if (!source) throw new Error('Open a device workspace to back it up.');
    if (this.busy) throw new Error('Another backup or restore is in progress.');
    const {ZipWriter,TextReader} = await import('@zip.js/zip.js');
    if (this.busy) throw new Error('Another backup or restore is in progress.');
    this.busy = true;
    let snapshot: Workspace | undefined;
    const writer = new ZipWriter(output, { useWebWorkers: false, zip64: true, level: 0 });
    try {
      await this.native.flush();
      snapshot = await this.store.captureBackup(source);
      const manifest: BackupManifest = { format: 'kept', version: 1, createdAt: new Date().toISOString(), preferences: snapshot.preferences, entries: [] };
      let after: string | undefined;
      let index = 0;
      while (true) {
        const [row] = await this.store.snapshotPage(snapshot.id, after);
        if (!row) break;
        after = row.key;
        const blob = row.store === 'blobs' ? row.record.value as Blob : new Blob([JSON.stringify(row.record.value)], { type: 'application/json' });
        const path = `${row.store === 'blobs' ? 'media' : 'records'}/${index++}`;
        const hash = sha256.create();
        const reader = blob.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { hash.update(chunk); controller.enqueue(chunk); } }));
        await writer.add(path, reader);
        manifest.entries.push({ path, kind: row.store === 'blobs' ? 'blob' : 'record', size: blob.size, sha256: bytesToHex(hash.digest()),
          ...(row.store === 'blobs' ? { blobKey: row.record.blobKey, mimeType: blob.type } : { type: (Object.keys(RESOURCE_STORES) as ResourceType[]).find(key => RESOURCE_STORES[key] === row.store)! }) });
        this.progress$.next(`Backing up ${index} items…`);
      }
      await writer.add('manifest.json', new TextReader(JSON.stringify(manifest)));
      await writer.close();
      this.exportedRevision = snapshot.revision;
    } finally {
      if (snapshot) await this.store.discardStaging(snapshot.id);
      this.busy = false; this.progress$.next('');
    }
  }

  async restore() {
    await this.native.ready;
    const plugin = this.native.plugin;
    if (!plugin || !this.native.capabilities$.value?.streamingFiles) throw new Error('Update the native Kept app to restore a device backup.');
    const file = await plugin.chooseImport();
    try {
      return await this.restoreFromReader(await nativeFileReader(file.reference, file.size, async (offset, length) => {
        const { base64 } = await plugin.readFileChunk({ reference: file.reference, offset, length });
        return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      }));
    } finally { await plugin.releaseImport({ reference: file.reference }); }
  }

  async restoreFromBlob(blob: Blob) { const {BlobReader} = await import('@zip.js/zip.js'); return this.restoreFromReader(new BlobReader(blob)); }

  async restoreFromReader(input: Reader<any>) {
    if (this.busy) throw new Error('Another backup or restore is in progress.');
    const {ZipReader,TextWriter} = await import('@zip.js/zip.js');
    if (this.busy) throw new Error('Another backup or restore is in progress.');
    this.busy = true;
    const reader = new ZipReader(input, { useWebWorkers: false, checkSignature: true, checkOverlappingEntry: true });
    let staging: Workspace | undefined;
    try {
      const entries = new Map<string, any>();
      for await (const entry of reader.getEntriesGenerator()) {
        if (entry.directory || entry.encrypted || entries.has(entry.filename) || !/^(manifest\.json|(?:records|media)\/\d+)$/.test(entry.filename)) throw new Error('This backup has an unsafe or duplicate ZIP entry.');
        if (entries.size >= 200000) throw new Error('This backup contains too many entries.');
        entries.set(entry.filename, entry);
      }
      const manifestEntry = entries.get('manifest.json');
      if (!manifestEntry || manifestEntry.uncompressedSize > JSON_LIMIT) throw new Error('The backup manifest is missing or too large.');
      const manifest: BackupManifest = JSON.parse(await manifestEntry.getData(new TextWriter()));
      if (manifest.format !== 'kept' || manifest.version !== 1 || !Array.isArray(manifest.entries) || entries.size !== manifest.entries.length + 1) throw new Error('Unsupported or incomplete Kept backup.');
      if (!manifest.preferences || !['light', 'dark'].includes(manifest.preferences.theme) || typeof manifest.preferences.followSystemTheme !== 'boolean' || typeof manifest.preferences.showPastReminders !== 'boolean') throw new Error('Invalid backup preferences.');
      staging = await this.workspaces.createLocal('staging');
      const seen = new Set<string>();
      const blobKeys = new Set<string>();
      const recordIds = new Map<ResourceType,Set<number>>();
      const binderNames = new Set<string>();
      for (const item of manifest.entries) {
        if (!item || (item.kind === 'blob' ? !/^media\/\d+$/.test(item.path) : item.kind !== 'record' || !/^records\/\d+$/.test(item.path))) throw new Error('Invalid backup entry path or kind.');
        const entry = entries.get(item.path);
        const limit = item.kind === 'blob' ? 25 * 1024 * 1024 : JSON_LIMIT;
        if (!entry || seen.has(item.path) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > limit || entry.uncompressedSize !== item.size || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid backup entry metadata.');
        seen.add(item.path);
        // Only one bounded record/media file is materialized at a time.
        const chunks: Uint8Array<ArrayBuffer>[] = []; let actualSize = 0;
        await entry.getData(new WritableStream<Uint8Array>({write(chunk) {
          actualSize += chunk.length;
          if (actualSize > item.size || actualSize > limit) throw new Error('A backup entry exceeds its declared size.');
          chunks.push(new Uint8Array(chunk));
        }}));
        if (actualSize !== item.size) throw new Error('A backup entry is incomplete.');
        const blob = new Blob(chunks,{type:item.mimeType || 'application/octet-stream'});
        const hash = sha256.create();
        const stream = blob.stream().getReader();
        while (true) { const chunk = await stream.read(); if (chunk.done) break; hash.update(chunk.value); }
        if (bytesToHex(hash.digest()) !== item.sha256) throw new Error(`Backup checksum failed: ${item.path}`);
        if (item.kind === 'blob') {
          if (!item.blobKey || !/^(media:|attachment:)/.test(item.blobKey) || item.blobKey.length > 2048) throw new Error('Invalid media identity.');
          if (blobKeys.has(item.blobKey)) throw new Error('The backup contains duplicate media identities.');
          blobKeys.add(item.blobKey);
          await this.store.putBlob(staging.partition, item.blobKey, blob);
        } else {
          if (!item.type || !RESOURCE_STORES[item.type]) throw new Error('Unknown backup record type.');
          const value = JSON.parse(await blob.text());
          if (!value || typeof value.syncId !== 'string' || !value.syncId || value.syncId.length > 160) throw new Error('Invalid backup record identity.');
          if (item.type !== 'preferences' && (!Number.isSafeInteger(value.id) || value.id <= 0)) throw new Error('Invalid backup numeric identity.');
          if (item.type !== 'preferences') {
            const ids = recordIds.get(item.type) || new Set<number>();
            if (ids.has(value.id)) throw new Error('Duplicate numeric record identity.');
            ids.add(value.id);recordIds.set(item.type,ids);
          }
          if (item.type === 'binder') binderNames.add(value.name);
          if (item.type === 'note') {
            if (['checkBoxes','images','labels'].some(field=>value[field] !== undefined && !Array.isArray(value[field]))) throw new Error('Invalid note data.');
            value.noteTitle = sanitizeNoteHtml(String(value.noteTitle || '')); value.noteBody = sanitizeNoteHtml(String(value.noteBody || ''));
            for (const box of value.checkBoxes || []) box.data = sanitizeNoteHtml(String(box.data || ''));
            value.collaborators = []; delete value.userId; delete value.ownerId;
          }
          await this.store.stageRecord(staging, item.type, value);
        }
        this.progress$.next(`Restoring ${seen.size} of ${manifest.entries.length} items…`);
      }
      const ids = new Set<number>();
      let afterNote: string | undefined;
      while (true) {
        const row = await this.store.resourcePage('note',staging.partition,afterNote); if (!row) break; afterNote = row.key;
        const note = row.value;
        if (ids.has(note.id)) throw new Error('The backup has duplicate note IDs.');
        ids.add(note.id);
        for (const label of note.labels || []) if (label.added && !recordIds.get('label')?.has(label.id)) throw new Error('A note refers to a missing Label.');
        if (note.binder && !binderNames.has(note.binder)) throw new Error('A note refers to a missing Binder.');
        for (const image of note.images || []) if (image.dataUrl.startsWith('/__kept_local_media/') && !blobKeys.has(`media:${image.dataUrl}`)) throw new Error('An image is missing from this backup.');
      }
      for (const type of ['reminder', 'attachment'] as const) {
        let after: string | undefined;
        while (true) {
          const row = await this.store.resourcePage(type,staging.partition,after); if (!row) break; after = row.key;
          if (row.value.noteId !== null && !ids.has(row.value.noteId)) throw new Error('A backup item refers to a missing note.');
          if (type === 'attachment' && !blobKeys.has(`attachment:${row.value.syncId}`)) throw new Error('An attachment file is missing from this backup.');
        }
      }
      const restored = await this.store.patchWorkspace(staging.id, { status: 'active', preferences: manifest.preferences, revision: 1, lastBackupAt: Date.now(), lastBackupRevision: 1 } as any);
      await this.workspaces.activate(restored);
      return restored;
    } catch (error) { if (staging) await this.store.discardStaging(staging.id); throw error; }
    finally { await reader.close(); this.busy = false; this.progress$.next(''); }
  }
}
