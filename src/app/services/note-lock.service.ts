import { OfflineSyncService } from './offline-sync.service';
import { Injectable } from '@angular/core';
import { WorkspaceService } from './workspace.service';
import { NoteI, UpdateKeyI } from '../interfaces/notes';

@Injectable({
  providedIn: 'root'
})
export class NoteLockService {
  constructor(private workspace: WorkspaceService, private sync: OfflineSyncService) {}
  private readonly unlockPrefix = 'kept_unlocked_note:';
  private readonly unlockMs = 5 * 60 * 1000;

  isLocked(note?: NoteI | null) {
    return !!(note?.locked && note.lockSalt && note.lockHash);
  }

  isUnlocked(note?: NoteI | null) {
    if (!this.isLocked(note)) return true;
    const key = this.noteKey(note!);
    if (!key) return false;
    try {
      const expiresAt = Number(sessionStorage.getItem(this.unlockPrefix + key) || 0);
      if (expiresAt > Date.now()) return true;
      sessionStorage.removeItem(this.unlockPrefix + key);
    } catch {}
    return false;
  }

  lockPreviewHidden(note?: NoteI | null) {
    return this.isLocked(note) && !this.isUnlocked(note);
  }

  async ensureUnlocked(note: NoteI) {
    if (!this.isLocked(note) || this.isUnlocked(note)) return true;
    const passcode = window.prompt(`Enter this note's passcode.`);
    if (!passcode) return false;
    const ok = await this.verify(note, passcode);
    if (!ok) {
      window.alert('Incorrect passcode.');
      return false;
    }
    this.markUnlocked(note);
    return true;
  }

  async createLockFields() {
    const passcode = window.prompt('Create a passcode for this note.');
    if (!passcode) return null;
    const confirmPasscode = window.prompt('Re-enter the passcode.');
    if (passcode !== confirmPasscode) {
      window.alert('Those passcodes did not match.');
      return null;
    }
    const salt = this.randomSalt();
    return {
      locked: true,
      lockSalt: salt,
      lockHash: await this.hash(passcode, salt)
    } satisfies UpdateKeyI;
  }

  async changeLockFields(note: NoteI) {
    const unlocked = await this.ensureUnlocked(note);
    if (!unlocked) return null;
    return this.createLockFields();
  }

  async removeLockFields(note: NoteI) {
    const unlocked = await this.ensureUnlocked(note);
    if (!unlocked) return null;
    this.clearUnlocked(note);
    return {
      locked: false,
      lockSalt: '',
      lockHash: ''
    } satisfies UpdateKeyI;
  }

  markUnlocked(note: NoteI) {
    const key = this.noteKey(note);
    if (!key) return;
    try { sessionStorage.setItem(this.unlockPrefix + key, String(Date.now() + this.unlockMs)); } catch {}
  }

  clearUnlocked(note: NoteI) {
    const key = this.noteKey(note);
    if (!key) return;
    try { sessionStorage.removeItem(this.unlockPrefix + key); } catch {}
  }

  private async verify(note: NoteI, passcode: string) {
    if (!note.lockSalt || !note.lockHash) return false;
    return await this.hash(passcode, note.lockSalt) === note.lockHash;
  }

  private noteKey(note: NoteI) {
    const key = note.syncId || (note.id != null ? String(note.id) : '');
    return `${this.sync.partition}:${this.sync.generation || 'pending'}:${key}`;
  }

  private randomSalt() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return this.base64Url(bytes);
  }

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
