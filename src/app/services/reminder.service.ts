import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { BehaviorSubject, firstValueFrom, Subject } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';
import { CalDavSettingsI, GoogleCalendarStatusI, IcsFeedI, ReminderFiredPayload, ReminderI, ReminderStatus } from '../interfaces/reminder';
import { PushNotificationService } from './push-notification.service';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';

type ReminderCreateData = {
  noteId?: number;
  noteSyncId?: string;
  dueAtUtc?: string;
  timezone?: string;
  title?: string;
  body?: string;
  imageUrl?: string;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  locationTrigger?: 'arrive' | 'leave';
};

type ReminderUpdateData = {
  status?: ReminderStatus;
  dueAtUtc?: string;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  locationTrigger?: 'arrive' | 'leave';
};

type AndroidLocationPermissionStatus = {
  foregroundGranted: boolean;
  backgroundGranted: boolean;
  status: 'granted' | 'foregroundOnly' | 'denied' | 'notDetermined';
};

type AndroidNotificationPermissionStatus = {
  granted: boolean;
  status: 'granted' | 'denied' | 'notDetermined';
};

type AndroidNativeGeofenceReminder = {
  id: string;
  noteId: string;
  savedPlaceId?: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  triggerType: 'arrive' | 'leave';
  status: 'pending';
  notificationTitle: string;
  notificationBody: string;
  deepLink: string;
  createdAt: string;
  updatedAt: string;
};

type AndroidTriggeredGeofenceEvent = {
  eventId: string;
  reminderId: string;
  noteId: string;
  transitionType: 'arrive' | 'leave' | 'dwell';
  triggeredAt: number;
};

interface KeptGeofencePlugin {
  getPermissionStatus(): Promise<AndroidLocationPermissionStatus>;
  requestForegroundLocationPermission(): Promise<AndroidLocationPermissionStatus>;
  openBackgroundLocationSettings(): Promise<void>;
  getNotificationPermissionStatus(): Promise<AndroidNotificationPermissionStatus>;
  requestNotificationPermission(): Promise<AndroidNotificationPermissionStatus>;
  syncGeofences(input: { reminders: AndroidNativeGeofenceReminder[] }): Promise<{
    registered: string[];
    failed: { reminderId: string; reason: string }[];
  }>;
  registerGeofence(reminder: AndroidNativeGeofenceReminder): Promise<void>;
  unregisterGeofence(input: { reminderId: string }): Promise<void>;
  getPendingTriggeredEvents(): Promise<{ events: AndroidTriggeredGeofenceEvent[] }>;
  acknowledgeTriggeredEvents(input: { eventIds: string[] }): Promise<void>;
}

const isAndroid = Capacitor.getPlatform() === 'android';
const KeptGeofence = isAndroid ? registerPlugin<KeptGeofencePlugin>('KeptGeofence') : null;

@Injectable({ providedIn: 'root' })
export class ReminderService {
  reminders$ = new BehaviorSubject<ReminderI[]>([]);
  firedReminder$ = new Subject<ReminderFiredPayload>();

  private readonly apiUrl = environment.apiUrl;
  private reminderTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private androidGeofenceSyncQueued = false;
  private androidGeofenceSyncRunning = false;
  private androidTriggeredEventsRunning = false;
  private androidResumeHandler?: () => void;
  private androidFocusHandler?: () => void;

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private push: PushNotificationService,
    private offlineStore: OfflineStoreService,
    private offlineSync: OfflineSyncService
  ) {
    this.offlineSync.cacheChanged$.subscribe(() => {
      this.loadCachedReminders().catch(console.error);
    });
    this.auth.currentUser$.subscribe(user => {
      if (user) {
        this.loadCachedReminders().catch(console.error);
        this.load().catch(console.error);
      }
      else this.setReminders([]);
    });
    this.listenForServiceWorkerMessages();
    this.listenForAndroidResume();
  }

  async load() {
    try {
      const reminders = await firstValueFrom(
        this.http.get<ReminderI[]>(`${this.apiUrl}/reminders`, { headers: this.auth.authHeaders() })
      );
      if (this.offlineSync.partition) {
        for (const reminder of reminders) await this.offlineStore.putReminder(this.offlineSync.partition, reminder);
      }
      this.setReminders(reminders);
      this.offlineSync.syncNow({ bootstrapIfEmpty: true }).catch(console.error);
    } catch (error) {
      await this.loadCachedReminders();
      if (navigator.onLine) throw error;
    }
  }

  async create(data: ReminderCreateData) {
    if (data.noteId && data.noteId < 0 && this.offlineSync.partition) {
      const note = await this.offlineStore.getNote(this.offlineSync.partition, data.noteId);
      data = { ...data, noteSyncId: note?.syncId };
    }
    const now = new Date().toISOString();
    const local = {
      ...data,
      id: -Date.now(),
      userId: this.auth.currentUser?.id || 0,
      dueAtUtc: data.dueAtUtc || null,
      timezone: data.timezone || 'UTC',
      repeatRule: null,
      status: 'pending' as ReminderStatus,
      title: data.title || null,
      body: data.body || null,
      imageUrl: data.imageUrl || null,
      locationName: data.locationName || null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      radiusMeters: data.radiusMeters ?? null,
      locationTrigger: data.locationTrigger || 'arrive',
      createdAt: now,
      updatedAt: now
    } as ReminderI & { noteSyncId?: string };
    this.offlineStore.ensureReminderIdentity(local);
    if (this.offlineSync.partition) await this.offlineStore.putReminder(this.offlineSync.partition, local);
    this.setReminders([local, ...this.reminders$.value.filter(item => item.noteId !== local.noteId)]);
    if (!navigator.onLine || (data.noteId || 0) < 0) {
      await this.offlineSync.enqueue('reminder.upsert', local.syncId!, local);
      return local;
    }
    try {
      const reminder = await firstValueFrom(
        this.http.post<ReminderI>(`${this.apiUrl}/reminders`, { ...data, syncId: local.syncId }, { headers: this.auth.authHeaders() })
      );
      if (this.offlineSync.partition) await this.offlineStore.putReminder(this.offlineSync.partition, reminder);
      await this.load();
      return reminder;
    } catch (error: any) {
      if (!navigator.onLine || error?.status === 0) {
        await this.offlineSync.enqueue('reminder.upsert', local.syncId!, local);
        return local;
      }
      console.warn('Reminder create failed (non-fatal):', error?.message || error);
      return null;
    }
  }

  async update(id: number, data: ReminderUpdateData) {
    const existing = this.reminders$.value.find(reminder => reminder.id === id);
    if (existing) {
      const local = { ...existing, ...data, updatedAt: new Date().toISOString() };
      if (this.offlineSync.partition) await this.offlineStore.putReminder(this.offlineSync.partition, local);
      this.setReminders(this.reminders$.value.map(reminder => reminder.id === id ? local : reminder));
      if (id < 0 || !navigator.onLine) {
        await this.offlineSync.enqueue('reminder.upsert', local.syncId!, local);
        return local;
      }
    }
    const reminder = await firstValueFrom(
      this.http.patch<ReminderI>(`${this.apiUrl}/reminders/${id}`, data, { headers: this.auth.authHeaders() })
    );
    await this.load();
    return reminder;
  }

  async delete(id: number) {
    const existing = this.reminders$.value.find(reminder => reminder.id === id);
    if (existing?.syncId && this.offlineSync.partition) {
      await this.offlineStore.deleteReminder(this.offlineSync.partition, existing.syncId);
      this.setReminders(this.reminders$.value.filter(reminder => reminder.id !== id));
    }
    if (id < 0 || !navigator.onLine) {
      if (existing?.syncId) await this.offlineSync.enqueue('reminder.delete', existing.syncId, existing);
      return;
    }
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}/reminders/${id}`, { headers: this.auth.authHeaders() })
    );
    await this.load();
  }

  private async loadCachedReminders() {
    if (!this.offlineSync.partition) return;
    const reminders = await this.offlineStore.listReminders(this.offlineSync.partition);
    this.setReminders(reminders);
  }

  getActiveForNote(noteId: number): ReminderI | undefined {
    return this.reminders$.value.find(r => r.noteId === noteId && r.status === 'pending');
  }

  handleFired(payload: ReminderFiredPayload) {
    const reminder = this.reminders$.value.find(r => r.id === payload.reminderId);
    if (reminder?.status === 'fired') return;
    this.firedReminder$.next(payload);
    const updated = this.reminders$.value.map(r =>
      r.id === payload.reminderId ? { ...r, status: 'fired' as ReminderStatus } : r
    );
    this.setReminders(updated);
  }

  debugFireReminder(title = 'Debug reminder', body = 'This is a manual test reminder.') {
    this.firedReminder$.next({
      reminderId: -Date.now(),
      noteId: null,
      title,
      body,
      imageUrl: null
    });
  }

  requestBrowserNotifications() {
    this.push.ensureSubscribed().catch(console.error);
  }

  /**
   * Call from inside a user-gesture handler (click) to request notification
   * permission. Required for iOS Safari, which only allows the prompt
   * synchronously from a gesture. Resolves when the permission decision is made.
   */
  async requestNotificationPermissionInGesture() {
    return this.push.requestPermissionFromGesture();
  }

  async ensureAndroidLocationReminderPermissions(): Promise<boolean> {
    if (!this.isAndroidGeofenceAvailable()) return true;
    try {
      let location = await KeptGeofence!.getPermissionStatus();
      if (!location.foregroundGranted) {
        location = await KeptGeofence!.requestForegroundLocationPermission();
      }
      if (!location.foregroundGranted) return false;

      if (!location.backgroundGranted) {
        return false;
      }

      let notifications = await KeptGeofence!.getNotificationPermissionStatus();
      if (!notifications.granted) {
        notifications = await KeptGeofence!.requestNotificationPermission();
      }
      return notifications.granted;
    } catch (error) {
      console.warn('Android location reminder permissions failed', error);
      this.showSnackbar('Location reminder permissions could not be checked.', 4500);
      return false;
    }
  }

  async getAndroidLocationPermissionStatus(): Promise<AndroidLocationPermissionStatus | null> {
    if (!this.isAndroidGeofenceAvailable()) return null;
    return KeptGeofence!.getPermissionStatus();
  }

  async requestAndroidForegroundLocationPermission(): Promise<AndroidLocationPermissionStatus | null> {
    if (!this.isAndroidGeofenceAvailable()) return null;
    return KeptGeofence!.requestForegroundLocationPermission();
  }

  async openAndroidBackgroundLocationSettings(): Promise<void> {
    if (!this.isAndroidGeofenceAvailable()) return;
    await KeptGeofence!.openBackgroundLocationSettings();
  }

  async ensureAndroidGeofenceNotificationPermission(): Promise<boolean> {
    if (!this.isAndroidGeofenceAvailable()) return true;
    let notifications = await KeptGeofence!.getNotificationPermissionStatus();
    if (!notifications.granted) {
      notifications = await KeptGeofence!.requestNotificationPermission();
    }
    return notifications.granted;
  }

  iosNeedsHomeScreenInstall() {
    return this.push.iosNeedsHomeScreenInstall();
  }

  isIos() { return this.push.isIos(); }
  isStandalone() { return this.push.isStandalone(); }

  private setReminders(reminders: ReminderI[]) {
    this.reminders$.next(reminders);
    this.schedulePendingReminders(reminders);
    this.syncAndroidGeofences(reminders);
    this.processAndroidTriggeredEvents();
  }

  private schedulePendingReminders(reminders: ReminderI[]) {
    this.reminderTimers.forEach(timer => clearTimeout(timer));
    this.reminderTimers.clear();

    reminders
      .filter(reminder => reminder.status === 'pending' && reminder.dueAtUtc)
      .forEach(reminder => {
        const dueIn = new Date(reminder.dueAtUtc!).getTime() - Date.now();
        const timer = setTimeout(() => this.fireLocalReminder(reminder.id), Math.max(0, dueIn));
        this.reminderTimers.set(reminder.id, timer);
      });
  }

  private fireLocalReminder(reminderId: number) {
    this.reminderTimers.delete(reminderId);
    const reminder = this.reminders$.value.find(r => r.id === reminderId);
    if (!reminder || reminder.status !== 'pending') return;

    this.firedReminder$.next({
      reminderId: reminder.id,
      noteId: reminder.noteId,
      title: reminder.title,
      body: reminder.body,
      imageUrl: reminder.imageUrl,
      source: 'local'
    });

    this.setReminders(this.reminders$.value.map(r =>
      r.id === reminderId ? { ...r, status: 'fired' as ReminderStatus } : r
    ));
    this.update(reminderId, { status: 'fired' }).catch(console.error);
  }

  private listenForServiceWorkerMessages() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'push-reminder-fired' && event.data.payload) {
        this.handleFired({ ...event.data.payload, source: 'sw-push' });
      }
    });
  }

  private listenForAndroidResume() {
    if (!this.isAndroidGeofenceAvailable() || typeof document === 'undefined') return;
    this.androidResumeHandler = () => {
      if (document.visibilityState === 'visible') {
        this.load().catch(console.error);
      }
    };
    this.androidFocusHandler = () => {
      this.load().catch(console.error);
    };
    document.addEventListener('visibilitychange', this.androidResumeHandler);
    window.addEventListener('focus', this.androidFocusHandler);
  }

  private isAndroidGeofenceAvailable() {
    return isAndroid && !!KeptGeofence;
  }

  private nativeLocationReminders(reminders: ReminderI[]): AndroidNativeGeofenceReminder[] {
    return reminders
      .filter(r =>
        r.status === 'pending' &&
        r.noteId &&
        r.locationName &&
        r.latitude != null &&
        r.longitude != null
      )
      .map(r => ({
        id: String(r.id),
        noteId: String(r.noteId),
        savedPlaceId: r.savedPlaceId ? String(r.savedPlaceId) : undefined,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        radiusMeters: Number(r.radiusMeters ?? 120),
        triggerType: r.locationTrigger === 'leave' ? 'leave' : 'arrive',
        status: 'pending',
        notificationTitle: r.title || 'Kept reminder',
        notificationBody: r.body || '',
        deepLink: `kept://note/${r.noteId}`,
        createdAt: r.createdAt || '',
        updatedAt: r.updatedAt || '',
      }));
  }

  private syncAndroidGeofences(reminders: ReminderI[]) {
    if (!this.isAndroidGeofenceAvailable()) return;
    if (this.androidGeofenceSyncRunning) {
      this.androidGeofenceSyncQueued = true;
      return;
    }
    this.androidGeofenceSyncRunning = true;
    const nativeReminders = this.nativeLocationReminders(reminders);
    KeptGeofence!.syncGeofences({ reminders: nativeReminders })
      .then(result => {
        if (result.failed?.length) {
          console.warn('Some Android geofences failed to sync', result.failed);
        }
      })
      .catch(error => console.warn('Android geofence sync failed', error))
      .finally(() => {
        this.androidGeofenceSyncRunning = false;
        if (this.androidGeofenceSyncQueued) {
          this.androidGeofenceSyncQueued = false;
          this.syncAndroidGeofences(this.reminders$.value);
        }
      });
  }

  private async processAndroidTriggeredEvents() {
    if (!this.isAndroidGeofenceAvailable() || this.androidTriggeredEventsRunning) return;
    this.androidTriggeredEventsRunning = true;
    try {
      const response = await KeptGeofence!.getPendingTriggeredEvents();
      const events = response.events || [];
      if (!events.length) return;

      const acknowledged: string[] = [];
      for (const event of events) {
        const reminderId = Number(event.reminderId);
        if (!Number.isFinite(reminderId)) continue;
        try {
          await this.update(reminderId, { status: 'fired' });
          acknowledged.push(event.eventId);
        } catch (error) {
          console.warn('Could not mark Android geofence reminder fired', event, error);
        }
      }
      if (acknowledged.length) {
        await this.load();
        await KeptGeofence!.acknowledgeTriggeredEvents({ eventIds: acknowledged });
      }
    } catch (error) {
      console.warn('Android geofence triggered event handling failed', error);
    } finally {
      this.androidTriggeredEventsRunning = false;
    }
  }

  private showSnackbar(text: string, duration = 4500) {
    try {
      (window as any).Snackbar?.show({ pos: 'bottom-left', text, duration });
    } catch {}
  }

  // ── CalDAV ──────────────────────────────────────────────────────────────

  async getCalDavSettings(): Promise<CalDavSettingsI | null> {
    return await firstValueFrom(
      this.http.get<CalDavSettingsI | null>(`${this.apiUrl}/caldav/settings`, { headers: this.auth.authHeaders() })
    );
  }

  async saveCalDavSettings(data: CalDavSettingsI & { password: string }): Promise<CalDavSettingsI> {
    return await firstValueFrom(
      this.http.put<CalDavSettingsI>(`${this.apiUrl}/caldav/settings`, data, { headers: this.auth.authHeaders() })
    );
  }

  async deleteCalDavSettings() {
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}/caldav/settings`, { headers: this.auth.authHeaders() })
    );
  }

  async testCalDavConnection(data: { calendarUrl: string; username: string; password: string }) {
    return await firstValueFrom(
      this.http.post<{ ok: boolean; httpStatus?: number; error?: string }>(
        `${this.apiUrl}/caldav/test`, data, { headers: this.auth.authHeaders() }
      )
    );
  }

  async importIcs(icsContent: string) {
    return await firstValueFrom(
      this.http.post<{ imported: number }>(
        `${this.apiUrl}/reminders/import`, { icsContent }, { headers: this.auth.authHeaders() }
      )
    );
  }

  // ── ICS Feed ─────────────────────────────────────────────────────────────

  async getIcsFeedToken(): Promise<IcsFeedI> {
    return await firstValueFrom(
      this.http.get<IcsFeedI>(`${this.apiUrl}/reminders/ics-token`, { headers: this.auth.authHeaders() })
    );
  }

  async regenerateIcsFeedToken(): Promise<IcsFeedI> {
    return await firstValueFrom(
      this.http.post<IcsFeedI>(`${this.apiUrl}/reminders/ics-token`, {}, { headers: this.auth.authHeaders() })
    );
  }

  // ── Google Calendar ───────────────────────────────────────────────────────

  async getGoogleCalendarStatus(): Promise<GoogleCalendarStatusI> {
    return await firstValueFrom(
      this.http.get<GoogleCalendarStatusI>(`${this.apiUrl}/google-calendar/status`, { headers: this.auth.authHeaders() })
    );
  }

  async saveGoogleCredentials(data: { clientId: string; clientSecret: string; enabled: boolean }): Promise<void> {
    await firstValueFrom(
      this.http.put(`${this.apiUrl}/google-calendar/credentials`, data, { headers: this.auth.authHeaders() })
    );
  }

  async initiateGoogleAuth(): Promise<{ url: string }> {
    return await firstValueFrom(
      this.http.post<{ url: string }>(`${this.apiUrl}/auth/google/initiate`, {}, { headers: this.auth.authHeaders() })
    );
  }

  async disconnectGoogleCalendar(): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}/google-calendar/disconnect`, { headers: this.auth.authHeaders() })
    );
  }

  async removeGoogleCredentials(): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}/google-calendar/credentials`, { headers: this.auth.authHeaders() })
    );
  }
}
