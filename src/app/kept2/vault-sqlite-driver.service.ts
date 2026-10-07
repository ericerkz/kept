import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { BrowserVaultSqliteDriverService } from './browser-vault-sqlite-driver.service';
import { VaultSqliteDriver } from './vault-types';

interface NativeVaultPlugin {
  getCapabilities(): Promise<{ nativeSqlite?: boolean }>;
  execute(input: { sql: string; params?: unknown[] }): Promise<{ changes?: number; id?: number }>;
  query(input: { sql: string; params?: unknown[] }): Promise<{ rows: unknown[] }>;
  putBlob(input: { key: string; base64: string }): Promise<void>;
  getBlob(input: { key: string }): Promise<{ base64: string | null }>;
  deleteBlob(input: { key: string }): Promise<void>;
}

const Kept2Vault = registerPlugin<NativeVaultPlugin>('Kept2Vault');

@Injectable({ providedIn: 'root' })
export class VaultSqliteDriverService implements VaultSqliteDriver {
  private nativeAvailable?: Promise<boolean>;
  private nativeSchemaInstalled?: Promise<void>;
  private transactionQueue = Promise.resolve();
  private inTransaction = false;

  constructor(private browser: BrowserVaultSqliteDriverService) {}

  async open(): Promise<void> {
    if (await this.useNative()) {
      await this.ensureNativeReady();
      return;
    }
    await this.browser.open();
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (!await this.useNative()) return this.browser.transaction(work);
    if (this.inTransaction) return work();
    const previous = this.transactionQueue;
    let release!: () => void;
    this.transactionQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      this.inTransaction = true;
      await this.run('BEGIN IMMEDIATE');
      const result = await work();
      await this.run('COMMIT');
      return result;
    } catch (error) {
      try { await this.run('ROLLBACK'); } catch {}
      throw error;
    } finally {
      this.inTransaction = false;
      release();
    }
  }

  async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    if (!await this.useNative()) return this.browser.get<T>(sql, params);
    await this.ensureNativeReady();
    const result = await Kept2Vault.query({ sql, params: this.normalizeParams(params) });
    return result.rows[0] as T | undefined;
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!await this.useNative()) return this.browser.all<T>(sql, params);
    await this.ensureNativeReady();
    const result = await Kept2Vault.query({ sql, params: this.normalizeParams(params) });
    return result.rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ id?: number; changes: number }> {
    if (!await this.useNative()) return this.browser.run(sql, params);
    await this.ensureNativeReady();
    const result = await Kept2Vault.execute({ sql, params: this.normalizeParams(params) });
    return {
      id: result.id,
      changes: Number(result.changes || 0)
    };
  }

  async putBlob(blobKey: string, blob: Blob): Promise<void> {
    if (!await this.useNative()) return this.browser.putBlob(blobKey, blob);
    await this.ensureNativeReady();
    await Kept2Vault.putBlob({
      key: blobKey,
      base64: this.bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
    });
  }

  async getBlob(blobKey: string): Promise<Blob | undefined> {
    if (!await this.useNative()) return this.browser.getBlob(blobKey);
    await this.ensureNativeReady();
    const result = await Kept2Vault.getBlob({ key: blobKey });
    if (!result.base64) return undefined;
    return new Blob([this.base64ToBytes(result.base64)]);
  }

  async deleteBlob(blobKey: string): Promise<void> {
    if (!await this.useNative()) return this.browser.deleteBlob(blobKey);
    await this.ensureNativeReady();
    await Kept2Vault.deleteBlob({ key: blobKey });
  }

  private async useNative() {
    this.nativeAvailable ||= this.detectNative();
    return this.nativeAvailable;
  }

  private async detectNative() {
    if (!Capacitor.isNativePlatform()) return false;
    try {
      const capabilities = await Kept2Vault.getCapabilities();
      return !!capabilities.nativeSqlite;
    } catch {
      return false;
    }
  }

  private async ensureNativeReady() {
    this.nativeSchemaInstalled ||= this.installNativeSchema();
    await this.nativeSchemaInstalled;
  }

  private normalizeParams(params: unknown[]) {
    return params.map(value => {
      if (value instanceof Uint8Array) return this.bytesToBase64(value);
      return value;
    });
  }

  private bytesToBase64(bytes: Uint8Array) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  private base64ToBytes(base64: string) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  private async installNativeSchema() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS vault_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`,
      `CREATE TABLE IF NOT EXISTS notes (
          syncId TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          searchText TEXT NOT NULL DEFAULT '',
          lwwPhysicalMs INTEGER NOT NULL DEFAULT 0,
          lwwLogical INTEGER NOT NULL DEFAULT 0,
          lwwDeviceId TEXT NOT NULL DEFAULT '',
          lwwOperationId TEXT NOT NULL DEFAULT '',
          deleted INTEGER NOT NULL DEFAULT 0,
          updatedAt TEXT NOT NULL
        )`,
      `CREATE TABLE IF NOT EXISTS reminders (
          syncId TEXT PRIMARY KEY,
          noteSyncId TEXT,
          value TEXT NOT NULL,
          lwwPhysicalMs INTEGER NOT NULL DEFAULT 0,
          lwwLogical INTEGER NOT NULL DEFAULT 0,
          lwwDeviceId TEXT NOT NULL DEFAULT '',
          lwwOperationId TEXT NOT NULL DEFAULT '',
          deleted INTEGER NOT NULL DEFAULT 0,
          updatedAt TEXT NOT NULL
        )`,
      `CREATE TABLE IF NOT EXISTS attachments (
          syncId TEXT PRIMARY KEY,
          noteSyncId TEXT,
          blobKey TEXT,
          value TEXT NOT NULL,
          lwwPhysicalMs INTEGER NOT NULL DEFAULT 0,
          lwwLogical INTEGER NOT NULL DEFAULT 0,
          lwwDeviceId TEXT NOT NULL DEFAULT '',
          lwwOperationId TEXT NOT NULL DEFAULT '',
          deleted INTEGER NOT NULL DEFAULT 0,
          updatedAt TEXT NOT NULL
        )`,
      `CREATE TABLE IF NOT EXISTS outbox (
          operationId TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0
        )`,
      `CREATE TABLE IF NOT EXISTS sync_cursors (
          name TEXT PRIMARY KEY,
          cursor INTEGER NOT NULL DEFAULT 0,
          updatedAt TEXT NOT NULL
        )`,
      `CREATE TABLE IF NOT EXISTS key_metadata (
          keyId TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )`,
      `CREATE TABLE IF NOT EXISTS blobs (
          blobKey TEXT PRIMARY KEY,
          bytes BLOB NOT NULL,
          updatedAt TEXT NOT NULL
        )`,
      'CREATE INDEX IF NOT EXISTS notes_deleted_updated_idx ON notes(deleted, updatedAt)',
      'CREATE INDEX IF NOT EXISTS notes_search_idx ON notes(searchText)',
      'CREATE INDEX IF NOT EXISTS reminders_note_idx ON reminders(noteSyncId)',
      'CREATE INDEX IF NOT EXISTS attachments_note_idx ON attachments(noteSyncId)',
      'CREATE INDEX IF NOT EXISTS outbox_created_idx ON outbox(createdAt)'
    ];
    for (const sql of statements) {
      await Kept2Vault.execute({ sql, params: [] });
    }
  }
}
