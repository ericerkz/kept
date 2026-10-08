import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { LabelI } from '../interfaces/labels';
import { ReminderI } from '../interfaces/reminder';

export const KEPT2_PROTOCOL_VERSION = 'encrypted-v1';

export type Kept2ResourceType =
  | 'note.content'
  | 'note.ownerState'
  | 'note.userState'
  | 'label'
  | 'binder'
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

export type VaultKeyWrapPurpose =
  | 'password'
  | 'recovery'
  | 'opaqueExport'
  | 'device';

export interface WrappedVaultKey {
  wrapId: string;
  purpose: VaultKeyWrapPurpose;
  algorithm: 'pbkdf2-sha256.secretbox' | 'raw-secretbox';
  salt: string | null;
  iterations: number | null;
  wrappedKey: string;
  createdAt: string;
}

export interface VaultKeyMaterial {
  vmk: Uint8Array;
  backupKey: Uint8Array;
  recoveryKey: Uint8Array;
  passwordWrap: WrappedVaultKey;
  recoveryWrap: WrappedVaultKey;
  recoveryCode: string;
}

export interface Kept2DeviceKeyPair {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
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

export interface VaultDevicePublicKey {
  vaultId: string;
  deviceId: string;
  publicKey: string;
  deviceLabel: string;
  status: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface HostedIntegrationServiceKey {
  integration: 'remote-mcp' | 'hosted-calendar';
  granteeId: string;
  publicKey: string;
}

export interface HostedIntegrationSetting {
  accountId?: string;
  integration: 'remote-mcp' | 'hosted-calendar';
  enabled: boolean;
  updatedAt: string | null;
  revokedGrants?: number;
  cancelledJobs?: number;
}

export interface HostedIntegrationConnection {
  connectionId: string;
  vaultId: string;
  integration: 'hosted-calendar';
  provider: string;
  displayName: string;
  status: 'active' | 'disabled' | 'deleted';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type Kept2MutationType =
  | 'resource.upsert'
  | 'resource.delete'
  | 'keyGrant.upsert'
  | 'keyGrant.revoke'
  | 'blob.put'
  | 'blob.delete';

export type Kept2LocalResourceKind = 'note' | 'reminder' | 'attachment' | 'label' | 'binder';

export interface BinderResource {
  syncId?: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

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
  devices?: VaultDevicePublicKey[];
  cursor: number;
  serverTime: number;
}

export interface SyncChanges {
  changes: Array<{
    sequence: number;
    operation: 'upsert' | 'delete';
    resourceId: string;
    resourceType: Kept2ResourceType;
    lww: LwwStamp;
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
  registerDevice?(vaultId: string, deviceId: string, publicKey: string, deviceLabel?: string): Promise<VaultDevicePublicKey>;
  listDevices?(vaultId: string): Promise<VaultDevicePublicKey[]>;
  revokeDevice?(vaultId: string, deviceId: string): Promise<void>;
  integrationSetting?(integration: 'remote-mcp' | 'hosted-calendar'): Promise<HostedIntegrationSetting | null>;
  setIntegrationEnabled?(integration: 'remote-mcp' | 'hosted-calendar', enabled: boolean): Promise<HostedIntegrationSetting>;
  integrationServiceKey?(integration: 'remote-mcp' | 'hosted-calendar'): Promise<HostedIntegrationServiceKey | null>;
  listHostedCalendarConnections?(vaultId: string): Promise<HostedIntegrationConnection[]>;
  upsertHostedCalendarConnection?(
    vaultId: string,
    connectionId: string,
    payload: { provider: string; displayName: string; encryptedSettings: string; status?: 'active' | 'disabled' }
  ): Promise<HostedIntegrationConnection>;
  deleteHostedCalendarConnection?(vaultId: string, connectionId: string): Promise<void>;
  createHostedIntegrationJob?(
    integration: 'remote-mcp' | 'hosted-calendar',
    vaultId: string,
    payload: { jobType: string; encryptedRequest: string; connectionId?: string }
  ): Promise<{ jobId: string; status: string }>;
  subscribeRealtime(vaultId: string, onChange: (event: { sequence: number; resourceId: string; vaultId?: string }) => void): () => void;
}

export interface DurableVaultStore {
  identity(): Promise<VaultIdentity>;
  listNotes(): Promise<NoteI[]>;
  searchNotes(query: string): Promise<NoteI[]>;
  putNote(note: NoteI, stamp?: LwwStamp): Promise<void>;
  getNote(syncId: string): Promise<NoteI | undefined>;
  deleteNote(syncId: string, stamp?: LwwStamp): Promise<void>;
  listLabels(): Promise<Array<LabelI & { syncId?: string }>>;
  putLabel(label: LabelI & { syncId?: string }, stamp?: LwwStamp): Promise<void>;
  deleteLabel(syncId: string, stamp?: LwwStamp): Promise<void>;
  listBinders(): Promise<BinderResource[]>;
  putBinder(binder: BinderResource, stamp?: LwwStamp): Promise<void>;
  deleteBinder(syncId: string, stamp?: LwwStamp): Promise<void>;
  listReminders(): Promise<ReminderI[]>;
  putReminder(reminder: ReminderI, stamp?: LwwStamp): Promise<void>;
  deleteReminder(syncId: string, stamp?: LwwStamp): Promise<void>;
  listAttachments(noteSyncId?: string): Promise<NoteAttachmentI[]>;
  putAttachment(attachment: NoteAttachmentI, blob?: Blob, stamp?: LwwStamp): Promise<void>;
  getBlob(blobKey: string): Promise<Blob | undefined>;
  deleteBlob(blobKey: string): Promise<void>;
  deleteAttachment(syncId: string, stamp?: LwwStamp): Promise<void>;
  enqueue(entry: Kept2OutboxEntry): Promise<void>;
  listOutbox(): Promise<Kept2OutboxEntry[]>;
  removeOutbox(operationIds: string[]): Promise<void>;
  getCursor(name: string): Promise<number>;
  setCursor(name: string, cursor: number): Promise<void>;
}
