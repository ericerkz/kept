export type ReminderStatus = 'pending' | 'fired' | 'dismissed' | 'snoozed';

export interface ReminderI {
  id: number;
  noteId: number | null;
  userId: number;
  dueAtUtc: string;
  timezone: string;
  repeatRule: string | null;
  status: ReminderStatus;
  title: string | null;
  body: string | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalDavSettingsI {
  serverUrl: string;
  calendarUrl: string;
  username: string;
  enabled: boolean;
  googleClientId?: string;
  googleClientSecret?: string;
}

export interface IcsImportResult {
  imported: number;
}

export interface ReminderFiredPayload {
  reminderId: number;
  noteId: number | null;
  title: string | null;
  body: string | null;
  imageUrl?: string | null;
  // 'sw-push' = the service-worker push handler already called showNotification
  // (so the in-page banner should NOT fire a duplicate Notification());
  // 'local' = fired by the in-page timer, the page must surface the OS notification.
  source?: 'sw-push' | 'local';
}

export interface IcsFeedI {
  token: string;
}

export interface GoogleCalendarStatusI {
  hasCredentials: boolean;
  connected: boolean;
  enabled: boolean;
  clientId: string | null;
}
