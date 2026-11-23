export type ResourceType = 'note' | 'reminder' | 'attachment' | 'label' | 'binder' | 'savedPlace' | 'preferences';
export const RESOURCE_STORES: Record<ResourceType, string> = {
  note: 'notes', reminder: 'reminders', attachment: 'attachments', label: 'labels',
  binder: 'binders', savedPlace: 'savedPlaces', preferences: 'preferences'
};
export type WorkspacePreferences = {
  defaultNoteColor?: string;
  language?: string;
  inheritSharedLabels?: boolean; inheritSharedBinders?: boolean;
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
  // Only freshly created libraries opt in; restored/older libraries never seed.
  demoNotesSeeded?: boolean;
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
  sortOrder?: number | null;
  shared?: boolean;
  ownerUserId?: number;
  ownerDisplayName?: string;
  ownerUsername?: string;
  memberCount?: number;
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
  resourceType: ResourceType | 'notePosition';
  resourceSyncId: string;
  operation: 'upsert' | 'delete';
  payload: Record<string, unknown> | null;
}
// A rejected deletion contains no new note content to lose. Restore the
// baseline and retain a conflict record instead of retrying it indefinitely.
// Never discard queued edits merely because an older or temporarily
// incompatible server returns 400/403/404.
export function isPermanentRejection(outcome: Pick<MutationOutcome, 'ok' | 'status'>, operationType: string): boolean {
  return operationType === 'note.delete' && !outcome.ok && [400, 403, 404].includes(Number(outcome.status));
}

export interface MutationOutcome {
  positions?: Array<{ id: number; syncId: string; sortOrder: number }>;
  operationId: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  // HTTP-style status the server attaches to a refused mutation.
  status?: number;
  resourceType?: ResourceType;
  syncId?: string;
  id?: number;
  canonical?: Record<string, unknown> | null;
}
