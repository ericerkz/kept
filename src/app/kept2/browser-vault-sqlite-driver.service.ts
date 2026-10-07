import { Injectable } from '@angular/core';
import sqlite3InitModule, { Database, BindingSpec } from '@sqlite.org/sqlite-wasm';
import { VaultSqliteDriver } from './vault-types';

@Injectable({ providedIn: 'root' })
export class BrowserVaultSqliteDriverService implements VaultSqliteDriver {
  private db?: Database;
  private openPromise?: Promise<void>;
  private transactionQueue = Promise.resolve();
  private inTransaction = false;

  async open() {
    if (!this.openPromise) {
      this.openPromise = this.openDatabase();
    }
    return this.openPromise;
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.open();
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

  async get<T = unknown>(sql: string, params: unknown[] = []) {
    await this.open();
    return this.database().selectObject(sql, params as BindingSpec) as T | undefined;
  }

  async all<T = unknown>(sql: string, params: unknown[] = []) {
    await this.open();
    return this.database().selectObjects(sql, params as BindingSpec) as T[];
  }

  async run(sql: string, params: unknown[] = []) {
    await this.open();
    this.database().exec({ sql, bind: params as BindingSpec });
    return {
      changes: Number(this.database().changes(false) || 0),
      id: this.lastInsertRowId()
    };
  }

  async putBlob(blobKey: string, blob: Blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await this.run(
      `INSERT INTO blobs (blobKey, bytes, updatedAt)
       VALUES (?, ?, ?)
       ON CONFLICT(blobKey) DO UPDATE SET bytes = excluded.bytes, updatedAt = excluded.updatedAt`,
      [blobKey, bytes, new Date().toISOString()]
    );
  }

  async getBlob(blobKey: string) {
    await this.open();
    const bytes = this.database().selectValue('SELECT bytes FROM blobs WHERE blobKey = ?', [blobKey] as BindingSpec);
    if (!(bytes instanceof Uint8Array)) return undefined;
    return new Blob([bytesToArrayBuffer(bytes)]);
  }

  async deleteBlob(blobKey: string) {
    await this.run('DELETE FROM blobs WHERE blobKey = ?', [blobKey]);
  }

  private async openDatabase() {
    const sqlite3 = await sqlite3InitModule();
    const filename = '/kept2-vault.sqlite3';
    try {
      const OpfsDb = sqlite3.oo1.OpfsDb;
      if (OpfsDb && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
        this.db = new OpfsDb(filename);
      }
    } catch {
      this.db = undefined;
    }
    this.db ||= new sqlite3.oo1.DB(filename, 'ct');
    this.installSchema();
  }

  private installSchema() {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        syncId TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        searchText TEXT NOT NULL DEFAULT '',
        lwwPhysicalMs INTEGER NOT NULL DEFAULT 0,
        lwwLogical INTEGER NOT NULL DEFAULT 0,
        lwwDeviceId TEXT NOT NULL DEFAULT '',
        lwwOperationId TEXT NOT NULL DEFAULT '',
        deleted INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminders (
        syncId TEXT PRIMARY KEY,
        noteSyncId TEXT,
        value TEXT NOT NULL,
        lwwPhysicalMs INTEGER NOT NULL DEFAULT 0,
        lwwLogical INTEGER NOT NULL DEFAULT 0,
        lwwDeviceId TEXT NOT NULL DEFAULT '',
        lwwOperationId TEXT NOT NULL DEFAULT '',
        deleted INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
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
      );
      CREATE TABLE IF NOT EXISTS outbox (
        operationId TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_cursors (
        name TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS key_metadata (
        keyId TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (
        blobKey TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_deleted_updated_idx ON notes(deleted, updatedAt);
      CREATE INDEX IF NOT EXISTS notes_search_idx ON notes(searchText);
      CREATE INDEX IF NOT EXISTS reminders_note_idx ON reminders(noteSyncId);
      CREATE INDEX IF NOT EXISTS attachments_note_idx ON attachments(noteSyncId);
      CREATE INDEX IF NOT EXISTS outbox_created_idx ON outbox(createdAt);
    `);
  }

  private database() {
    if (!this.db) throw new Error('Vault database is not open.');
    return this.db;
  }

  private lastInsertRowId() {
    const value = this.database().selectValue('SELECT last_insert_rowid()');
    return typeof value === 'number' ? value : undefined;
  }
}

function bytesToArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
