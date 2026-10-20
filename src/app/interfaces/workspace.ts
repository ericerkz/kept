export type ResourceType = 'note' | 'reminder' | 'attachment' | 'label' | 'binder' | 'savedPlace' | 'preferences';
export const RESOURCE_STORES: Record<ResourceType, string> = {
  note: 'notes', reminder: 'reminders', attachment: 'attachments', label: 'labels',
  binder: 'binders', savedPlace: 'savedPlaces', preferences: 'preferences'
};
export type WorkspacePreferences = {
  theme: 'light' | 'dark'; followSystemTheme: boolean; showPastReminders: boolean;
};
export interface Workspace {
  id: string;
  partition: string;
  mode: 'local' | 'server';
  generation: string;
  status: 'active' | 'staging' | 'frozen' | 'retained';
  createdAt: string;
  updatedAt: string;
  preferences: WorkspacePreferences;
  nextId: number;
  revision: number;
  lastBackupAt?: number;
  backupReminderDismissedAt?: number;
  backupRemindersDisabled?: boolean;
  protocolVersion?: number;
  migration?: { importId: string; server: string; state: 'uploading' | 'verifying' | 'complete' };
}
export interface CatalogItem {
  id: number;
  syncId: string;
  name: string;
  updatedAt: string;
}
export interface NativeAction {
  actionId: string;
  workspaceId: string;
  generation: string;
  sequence: number;
  kind: 'note.upsert' | 'note.delete' | 'checklist.set' | 'reminder.upsert' | 'reminder.delete' | 'reminder.occurrence';
  targetSyncId: string;
  baseRevision?: number;
  payload: Record<string, unknown>;
  files?: Array<{ reference: string; name: string; size: number; mimeType: string }>;
}
export interface NativeCapabilities {
  version: 1;
  durableActions: boolean;
  workspaceSnapshots: boolean;
  streamingFiles: boolean;
  androidRecurringReminders: boolean;
  appleReminderChanges: boolean;
  offlineCaptureActions: string[];
}
export interface ResourceChange {
  sequence: number;
  resourceType: ResourceType;
  resourceSyncId: string;
  operation: 'upsert' | 'delete';
  payload: Record<string, unknown> | null;
}
export interface MutationOutcome {
  operationId: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  resourceType?: ResourceType;
  syncId?: string;
  id?: number;
  canonical?: Record<string, unknown> | null;
}
