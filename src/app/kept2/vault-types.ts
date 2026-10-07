import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';

export const KEPT2_PROTOCOL_VERSION = 'encrypted-v1';

export type Kept2ResourceType =
  | 'note.content'
  | 'note.ownerState'
  | 'note.userState'
  | 'reminder'
  | 'attachment'
  | 'blob'
  | 'keyGrant'
  | 'migrationBackup';

export type Kept2GrantPurpose =
  | 'device'
  | 'recovery'
  | 'collaborator'
  | 'mcp'
  | 'calendar'
  | 'migration';

export interface VaultIdentity {
  vaultId: string;
  deviceId: string;
  protocolVersion: string;
  createdAt: string;
  lastUnlockedAt: string | null;
}

export interface VaultSqliteDriver {
  open(): Promise<void>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ id?: number; changes: number }>;
  putBlob(blobKey: string, blob: Blob): Promise<void>;
  getBlob(blobKey: string): Promise<Blob | undefined>;
  deleteBlob(blobKey: string): Promise<void>;
}

export interface LwwStamp {
  physicalMs: number;
  logical: number;
  deviceId: string;
  operationId: string;
}

export interface EncryptedEnvelope {
  resourceId: string;
  resourceType: Kept2ResourceType;
  keyEpoch: number;
  lww: LwwStamp;
  ciphertext: string;
  nonce: string;
  aad: Record<string, string | number | boolean | null>;
  ciphertextHash: string;
  schemaVersion: number;
}

export interface KeyGrant {
  grantId: string;
  vaultId: string;
  resourceId: string;
  resourceType: Kept2ResourceType;
  granteeId: string;
  grantPurpose: Kept2GrantPurpose;
  keyEpoch: number;
  wrappedKey: string;
  createdAt: string;
  revokedAt: string | null;
}

export type Kept2MutationType =
  | 'resource.upsert'
  | 'resource.delete'
  | 'keyGrant.upsert'
  | 'keyGrant.revoke'
  | 'blob.put'
  | 'blob.delete';

export interface Kept2OutboxEntry {
  operationId: string;
  mutationType: Kept2MutationType;
  resourceId: string;
  payload: unknown;
  lww: LwwStamp;
  createdAt: string;
  attempts: number;
}

export interface SyncCapabilities {
  protocolVersion: string;
  encryptedResources: boolean;
  encryptedBlobs: boolean;
  contentBlindRealtime: boolean;
  legacyRuntime: boolean;
}

export interface SyncSnapshot {
  envelopes: EncryptedEnvelope[];
  keyGrants: KeyGrant[];
  cursor: number;
  serverTime: number;
}

export interface SyncChanges {
  changes: Array<{
    sequence: number;
    operation: 'upsert' | 'delete';
    resourceId: string;
    resourceType: Kept2ResourceType;
    envelope: EncryptedEnvelope | null;
  }>;
  cursor: number;
  hasMore: boolean;
  serverTime: number;
}

export interface MutationResult {
  ok: boolean;
  operationId: string;
  sequence?: number;
  skipped?: boolean;
  error?: string;
}

export interface SyncTransport {
  capabilities(): Promise<SyncCapabilities>;
  bootstrap(vaultId: string): Promise<SyncSnapshot>;
  changes(vaultId: string, cursor: number): Promise<SyncChanges>;
  mutate(vaultId: string, mutations: Kept2OutboxEntry[]): Promise<MutationResult[]>;
  uploadBlob(vaultId: string, blobId: string, ciphertext: Blob, ciphertextHash: string): Promise<void>;
  downloadBlob(vaultId: string, blobId: string): Promise<Blob>;
  subscribeRealtime(vaultId: string, onChange: (event: { sequence: number; resourceId: string }) => void): () => void;
}

export interface DurableVaultStore {
  identity(): Promise<VaultIdentity>;
  listNotes(): Promise<NoteI[]>;
  putNote(note: NoteI, stamp?: LwwStamp): Promise<void>;
  getNote(syncId: string): Promise<NoteI | undefined>;
  deleteNote(syncId: string, stamp?: LwwStamp): Promise<void>;
  listReminders(): Promise<ReminderI[]>;
  putReminder(reminder: ReminderI, stamp?: LwwStamp): Promise<void>;
  deleteReminder(syncId: string, stamp?: LwwStamp): Promise<void>;
  listAttachments(noteSyncId?: string): Promise<NoteAttachmentI[]>;
  putAttachment(attachment: NoteAttachmentI, blob?: Blob, stamp?: LwwStamp): Promise<void>;
  deleteAttachment(syncId: string, stamp?: LwwStamp): Promise<void>;
  enqueue(entry: Kept2OutboxEntry): Promise<void>;
  listOutbox(): Promise<Kept2OutboxEntry[]>;
  removeOutbox(operationIds: string[]): Promise<void>;
}

