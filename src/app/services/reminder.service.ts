import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { BehaviorSubject, firstValueFrom, Subject } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';
import { CalDavSettingsI, GoogleCalendarStatusI, IcsFeedI, ReminderFiredPayload, ReminderI, ReminderRepeatRule, ReminderStatus } from '../interfaces/reminder';
import { PushNotificationService } from './push-notification.service';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';
import { NoteI } from '../interfaces/notes';
import { UserPreferencesService } from './user-preferences.service';
import { LocalFirstVaultService } from '../kept2/local-first-vault.service';
import { VaultSessionService } from '../kept2/vault-session.service';

type ReminderCreateData = {
  noteId?: number;
  noteSyncId?: string;
  dueAtUtc?: string;
  timezone?: string;
  title?: string;
  body?: string;
  imageUrl?: string;
  repeatRule?: string | ReminderRepeatRule | null;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  locationTrigger?: 'arrive' | 'leave';
};

type ReminderUpdateData = {
  status?: ReminderStatus;
  dueAtUtc?: string;
  repeatRule?: string | ReminderRepeatRule | null;
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

type AndroidNativeTimeReminder = {
  id: string;
  fireAtMs: number;
  title: string;
  body?: string;
  deepLink?: string;
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

interface KeptTimeRemindersPlugin {
  syncTimeReminders(input: { reminders: AndroidNativeTimeReminder[] }): Promise<{
    scheduled: string[];
    skipped: { id: string; reason: string }[];
    exact: boolean;
  }>;
  cancelTimeReminder(input: { id: string }): Promise<void>;
  getExactAlarmStatus(): Promise<{ canScheduleExact: boolean }>;
  openExactAlarmSettings(): Promise<void>;
}

const isAndroid = Capacitor.getPlatform() === 'android';
const KeptGeofence = isAndroid ? registerPlugin<KeptGeofencePlugin>('KeptGeofence') : null;
const KeptTimeReminders = isAndroid ? registerPlugin<KeptTimeRemindersPlugin>('KeptTimeReminders') : null;

@Injectable({ providedIn: 'root' })
export class ReminderService {
  reminders$ = new BehaviorSubject<ReminderI[]>([]);
  firedReminder$ = new Subject<ReminderFiredPayload>();

  private readonly apiUrl = environment.apiUrl;
  private reminderTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private androidGeofenceSyncQueued = false;
  private androidGeofenceSyncRunning = false;
  private androidTimeReminderSyncQueued = false;
  private androidTimeReminderSyncRunning = false;
  private androidExactAlarmPromptShown = false;
  private androidTriggeredEventsRunning = false;
  private androidResumeHandler?: () => void;
  private androidFocusHandler?: () => void;
  private inactiveNoteIds = new Set<number>();
  private displayedNotifications = new Map<number, Notification>();
  private lifecycleUserId?: number;
  private readonly reminderTimerChunkMs = 24 * 60 * 60 * 1000;
  private kept2SyntheticNoteIds = new Map<string, number>();
  private kept2NoteSyncIdsBySyntheticId = new Map<number, string>();

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private push: PushNotificationService,
    private offlineStore: OfflineStoreService,
    private offlineSync: OfflineSyncService,
    private userPreferences: UserPreferencesService,
    private localFirstVault: LocalFirstVaultService,
    private vaultSession: VaultSessionService
  ) {
    this.offlineSync.cacheChanged$.subscribe(() => {
      this.loadCachedReminders().catch(console.error);
    });
    this.auth.currentUser$.subscribe(user => {
      if (user?.id !== this.lifecycleUserId) {
        this.inactiveNoteIds.clear();
        this.lifecycleUserId = user?.id;
      }
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
    if (this.useKept2LocalFirst()) {
      const reminders = await this.hydrateKept2ReminderNoteIds(await this.localFirstVault.reminders());
      this.setReminders(reminders);
      return;
    }
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
    if (this.useKept2LocalFirst()) {
      const now = new Date().toISOString();
      const noteSyncId = data.noteSyncId || await this.kept2NoteSyncIdForId(data.noteId);
      const noteId = data.noteId ?? (noteSyncId ? this.kept2SyntheticNoteId(noteSyncId) : null);
      const local: ReminderI & { noteSyncId?: string } = {
        ...data,
        id: this.nextLocalReminderId(),
        syncId: `reminder-${crypto.randomUUID()}`,
        userId: this.auth.currentUser?.id || 0,
        noteId,
        noteSyncId,
        dueAtUtc: data.dueAtUtc || null,
        timezone: data.timezone || 'UTC',
        repeatRule: this.serializeRepeatRule(data.repeatRule),
        status: 'pending',
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
      };
      const reminder = await this.localFirstVault.upsertReminder(local);
      this.setReminders([reminder, ...this.reminders$.value.filter(item => item.noteId !== reminder.noteId)]);
      return reminder;
    }
    if (data.noteId && data.noteId < 0 && this.offlineSync.partition) {
      const note = await this.offlineStore.getNote(this.offlineSync.partition, data.noteId);
      data = { ...data, noteSyncId: note?.syncId };
    }
    const payload = { ...data, repeatRule: this.serializeRepeatRule(data.repeatRule) };
    const now = new Date().toISOString();
    let localId = -Date.now();
    if (this.offlineSync.partition) {
      const reminders = await this.offlineStore.listReminders(this.offlineSync.partition);
      const usedIds = new Set(reminders.map(reminder => reminder.id));
      while (usedIds.has(localId)) localId -= 1;
    }
    const local = {
      ...data,
      id: localId,
      userId: this.auth.currentUser?.id || 0,
      dueAtUtc: data.dueAtUtc || null,
      timezone: data.timezone || 'UTC',
      repeatRule: this.serializeRepeatRule(data.repeatRule),
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
        this.http.post<ReminderI>(`${this.apiUrl}/reminders`, { ...payload, syncId: local.syncId }, { headers: this.auth.authHeaders() })
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
    const payload: ReminderUpdateData = { ...data };
    if (Object.prototype.hasOwnProperty.call(data, 'repeatRule')) {
      payload.repeatRule = this.serializeRepeatRule(data.repeatRule);
    }
    if (this.useKept2LocalFirst()) {
      const existing = this.reminders$.value.find(reminder => reminder.id === id);
      if (!existing?.syncId) return existing || null;
      const local = {
        ...existing,
        ...payload,
        repeatRule: payload.repeatRule === undefined ? existing.repeatRule : payload.repeatRule as string | null,
        updatedAt: new Date().toISOString()
      };
      const reminder = await this.localFirstVault.upsertReminder(local);
      this.setReminders(this.reminders$.value.map(item => item.id === id ? reminder : item));
      if (payload.status && payload.status !== 'pending') this.cancelAndroidTimeReminder(id);
      return reminder;
    }
    const existing = this.reminders$.value.find(reminder => reminder.id === id);
    if (existing) {
      const local: ReminderI = { ...existing, ...payload, repeatRule: payload.repeatRule === undefined ? existing.repeatRule : payload.repeatRule as string | null, updatedAt: new Date().toISOString() };
      if (this.offlineSync.partition) await this.offlineStore.putReminder(this.offlineSync.partition, local);
      this.setReminders(this.reminders$.value.map(reminder => reminder.id === id ? local : reminder));
      if (payload.status && payload.status !== 'pending') this.cancelAndroidTimeReminder(id);
      if (id < 0 || !navigator.onLine) {
        await this.offlineSync.enqueue('reminder.upsert', local.syncId!, local);
        return local;
      }
    }
    const reminder = await firstValueFrom(
      this.http.patch<ReminderI>(`${this.apiUrl}/reminders/${id}`, payload, { headers: this.auth.authHeaders() })
    );
    await this.load();
    return reminder;
  }

  async delete(id: number) {
    const existing = this.reminders$.value.find(reminder => reminder.id === id);
    this.cancelAndroidTimeReminder(id);
    if (this.useKept2LocalFirst()) {
      if (existing?.syncId) await this.localFirstVault.deleteReminder(existing.syncId);
      this.setReminders(this.reminders$.value.filter(reminder => reminder.id !== id));
      return;
    }
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
    if (this.useKept2LocalFirst()) return;
    if (!this.offlineSync.partition) return;
    const reminders = await this.offlineStore.listReminders(this.offlineSync.partition);
    this.setReminders(reminders);
  }

  private useKept2LocalFirst() {
    try {
      return localStorage.getItem('kept2LocalFirst') === '1' && this.vaultSession.isUnlocked();
    } catch {
      return false;
    }
  }

  private async hydrateKept2ReminderNoteIds(reminders: ReminderI[]) {
    const notes = await this.localFirstVault.notes();
    for (const note of notes) {
      if (!note.syncId) continue;
      const syntheticId = this.kept2SyntheticNoteId(note.syncId);
      this.kept2NoteSyncIdsBySyntheticId.set(syntheticId, note.syncId);
    }
    return reminders.map(reminder => {
      const noteSyncId = (reminder as ReminderI & { noteSyncId?: string }).noteSyncId || '';
      if (!noteSyncId) return reminder;
      return {
        ...reminder,
        noteId: reminder.noteId || this.kept2SyntheticNoteId(noteSyncId),
        noteSyncId
      };
    });
  }

  private async kept2NoteSyncIdForId(noteId: number | undefined | null) {
    if (!noteId) return '';
    const cached = this.kept2NoteSyncIdsBySyntheticId.get(noteId);
    if (cached) return cached;
    const notes = await this.localFirstVault.notes();
    for (const note of notes) {
      if (!note.syncId) continue;
      const syntheticId = this.kept2SyntheticNoteId(note.syncId);
      this.kept2NoteSyncIdsBySyntheticId.set(syntheticId, note.syncId);
      if (syntheticId === noteId || note.id === noteId) return note.syncId;
    }
    return '';
  }

  private kept2SyntheticNoteId(syncId: string) {
    const existing = this.kept2SyntheticNoteIds.get(syncId);
    if (existing) return existing;
    let hash = 0;
    for (let index = 0; index < syncId.length; index += 1) {
      hash = ((hash << 5) - hash + syncId.charCodeAt(index)) | 0;
    }
    let id = -Math.max(1, Math.abs(hash));
    while (this.kept2NoteSyncIdsBySyntheticId.has(id) && this.kept2NoteSyncIdsBySyntheticId.get(id) !== syncId) {
      id -= 1;
    }
    this.kept2SyntheticNoteIds.set(syncId, id);
    this.kept2NoteSyncIdsBySyntheticId.set(id, syncId);
    return id;
  }

  private nextLocalReminderId() {
    const usedIds = new Set(this.reminders$.value.map(reminder => reminder.id));
    let id = -Date.now();
    while (usedIds.has(id)) id -= 1;
    return id;
  }

  getActiveForNote(noteId: number): ReminderI | undefined {
    return this.reminders$.value.find(r => r.noteId === noteId && r.status === 'pending');
  }

  getFiredForNote(noteId: number): ReminderI | undefined {
    return this.reminders$.value.find(r => r.noteId === noteId && r.status === 'fired');
  }

  updateNoteLifecycle(notes: Array<{ id?: number; archived?: boolean; trashed?: boolean }>) {
    let changed = false;
    for (const note of notes) {
      const noteId = Number(note.id || 0);
      if (!noteId) continue;
      const inactive = !!note.archived || !!note.trashed;
      if (inactive && !this.inactiveNoteIds.has(noteId)) {
        this.inactiveNoteIds.add(noteId);
        this.cancelReminderTimersForNote(noteId);
        this.cancelAndroidTimeRemindersForNote(noteId);
        this.closeDisplayedNotificationsForNote(noteId).catch(console.error);
        changed = true;
      } else if (!inactive && this.inactiveNoteIds.delete(noteId)) {
        changed = true;
      }
    }
    if (changed) {
      this.schedulePendingReminders(this.reminders$.value);
      this.syncAndroidGeofences(this.reminders$.value);
      this.syncAndroidTimeReminders(this.reminders$.value);
    }
  }

  markNoteInactive(noteId: number) {
    if (!noteId) return;
    this.inactiveNoteIds.add(noteId);
    this.cancelReminderTimersForNote(noteId);
    this.cancelAndroidTimeRemindersForNote(noteId);
    this.closeDisplayedNotificationsForNote(noteId).catch(console.error);
    this.syncAndroidGeofences(this.reminders$.value);
    this.syncAndroidTimeReminders(this.reminders$.value);
  }

  async refreshNoteContent(note: NoteI) {
    if (!note.id || note.locked) return;
    const noteId = note.id;
    const matching = this.reminders$.value.filter(reminder =>
      reminder.noteId === noteId || (!!note.syncId && (reminder as ReminderI & { noteSyncId?: string }).noteSyncId === note.syncId)
    );
    if (!matching.length) return;
    const title = this.plainText(note.noteTitle || '');
    const bodyText = this.plainText(note.noteBody || '');
    const checklistText = (note.checkBoxes || [])
      .map(item => this.plainText(item.data || ''))
      .filter(Boolean)
      .join(' ');
    const body = (bodyText || checklistText).slice(0, 500);

    const changedIds = new Set<number>();
    const now = new Date().toISOString();
    const next = this.reminders$.value.map(reminder => {
      const noteMatches = reminder.noteId === noteId || (!!note.syncId && (reminder as ReminderI & { noteSyncId?: string }).noteSyncId === note.syncId);
      if (!noteMatches || ((reminder.title || '') === title && (reminder.body || '') === body)) return reminder;
      changedIds.add(reminder.id);
      return { ...reminder, noteId, noteSyncId: note.syncId || (reminder as ReminderI & { noteSyncId?: string }).noteSyncId, title: title || null, body: body || null, updatedAt: now };
    });
    if (!changedIds.size) return;

    if (this.useKept2LocalFirst()) {
      for (const reminder of next) {
        if (changedIds.has(reminder.id) && reminder.syncId) await this.localFirstVault.upsertReminder(reminder);
      }
    } else if (this.offlineSync.partition) {
      for (const reminder of next) {
        if (changedIds.has(reminder.id)) await this.offlineStore.putReminder(this.offlineSync.partition, reminder);
      }
    }
    this.setReminders(next);
  }

  trackDisplayedNotification(reminderId: number, notification: Notification) {
    if (!reminderId) return;
    this.displayedNotifications.get(reminderId)?.close();
    this.displayedNotifications.set(reminderId, notification);
    notification.addEventListener('close', () => {
      if (this.displayedNotifications.get(reminderId) === notification) this.displayedNotifications.delete(reminderId);
    }, { once: true });
  }

  handleFired(payload: ReminderFiredPayload) {
    const reminder = this.reminders$.value.find(r => r.id === payload.reminderId);
    if (reminder?.status === 'fired') return;
    this.firedReminder$.next(payload);
    const repeat = this.parseRepeatRule(reminder?.repeatRule);
    if (this.isRepeatingRule(repeat)) {
      this.load().catch(console.error);
      return;
    }
    const updated = this.reminders$.value.map(r =>
      r.id === payload.reminderId ? { ...r, status: 'fired' as ReminderStatus } : r
    );
    this.setReminders(updated);
  }

  async dismissFiredReminder(reminderId: number) {
    const reminder = this.reminders$.value.find(r => r.id === reminderId);
    if (this.isRepeatingRule(this.parseRepeatRule(reminder?.repeatRule))) {
      if (navigator.onLine) await this.load().catch(console.error);
      return reminder || null;
    }
    if (this.userPreferences.value.showPastReminders) {
      return reminder || null;
    }
    return this.update(reminderId, { status: 'dismissed' });
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
    this.syncAndroidTimeReminders(reminders);
    this.processAndroidTriggeredEvents();
  }

  private schedulePendingReminders(reminders: ReminderI[]) {
    this.reminderTimers.forEach(timer => clearTimeout(timer));
    this.reminderTimers.clear();

    reminders
      .filter(reminder => reminder.status === 'pending' && reminder.dueAtUtc && !this.inactiveNoteIds.has(Number(reminder.noteId)))
      .forEach(reminder => {
        const dueAt = new Date(reminder.dueAtUtc!).getTime();
        if (!Number.isFinite(dueAt)) return;
        const dueIn = dueAt - Date.now();
        const delay = Math.max(0, Math.min(dueIn, this.reminderTimerChunkMs));
        const timer = setTimeout(() => this.handleReminderTimer(reminder.id), delay);
        this.reminderTimers.set(reminder.id, timer);
      });
  }

  private handleReminderTimer(reminderId: number) {
    const reminder = this.reminders$.value.find(r => r.id === reminderId);
    if (!reminder || reminder.status !== 'pending' || !reminder.dueAtUtc) {
      this.reminderTimers.delete(reminderId);
      return;
    }

    const dueAt = new Date(reminder.dueAtUtc).getTime();
    if (!Number.isFinite(dueAt)) {
      this.reminderTimers.delete(reminderId);
      return;
    }

    const dueIn = dueAt - Date.now();
    if (dueIn > 0) {
      const delay = Math.min(dueIn, this.reminderTimerChunkMs);
      const timer = setTimeout(() => this.handleReminderTimer(reminderId), delay);
      this.reminderTimers.set(reminderId, timer);
      return;
    }

    this.fireLocalReminder(reminderId);
  }

  private cancelReminderTimersForNote(noteId: number) {
    for (const reminder of this.reminders$.value) {
      if (reminder.noteId !== noteId) continue;
      const timer = this.reminderTimers.get(reminder.id);
      if (timer) clearTimeout(timer);
      this.reminderTimers.delete(reminder.id);
    }
  }

  private cancelAndroidTimeRemindersForNote(noteId: number) {
    for (const reminder of this.reminders$.value) {
      if (reminder.noteId === noteId) this.cancelAndroidTimeReminder(reminder.id);
    }
  }

  private async closeDisplayedNotificationsForNote(noteId: number) {
    const reminderIds = new Set(
      this.reminders$.value
        .filter(reminder => reminder.noteId === noteId)
        .map(reminder => reminder.id)
    );
    for (const reminderId of reminderIds) {
      this.displayedNotifications.get(reminderId)?.close();
      this.displayedNotifications.delete(reminderId);
    }

    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      const getNotifications = (registration as any).getNotifications;
      if (typeof getNotifications !== 'function') continue;
      const notifications: Notification[] = await getNotifications.call(registration);
      notifications.forEach(notification => {
        const notificationReminderId = Number(notification.data?.reminderId || 0);
        const notificationNoteId = Number(notification.data?.noteId || 0);
        if (notificationNoteId === noteId || reminderIds.has(notificationReminderId)) notification.close();
      });
    }
  }

  private plainText(value: string) {
    if (typeof document !== 'undefined') {
      const div = document.createElement('div');
      div.innerHTML = value;
      return (div.textContent || '').replace(/\s+/g, ' ').trim();
    }
    return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private async fireLocalReminder(reminderId: number) {
    this.reminderTimers.delete(reminderId);
    const reminder = this.reminders$.value.find(r => r.id === reminderId);
    if (!reminder || reminder.status !== 'pending') return;
    const repeat = this.parseRepeatRule(reminder.repeatRule);
    const nextDueAtUtc = repeat ? this.nextRepeatDueAt(reminder.dueAtUtc, repeat) : null;

    this.firedReminder$.next({
      reminderId: reminder.id,
      noteId: reminder.noteId,
      title: reminder.title,
      body: reminder.body,
      imageUrl: reminder.imageUrl,
      source: 'local'
    });

    if (repeat && nextDueAtUtc) {
      const local = { ...reminder, dueAtUtc: nextDueAtUtc, status: 'pending' as ReminderStatus, updatedAt: new Date().toISOString() };
      if (this.offlineSync.partition) await this.offlineStore.putReminder(this.offlineSync.partition, local);
      this.setReminders(this.reminders$.value.map(r => r.id === reminderId ? local : r));
      if (repeat.moveToTopOnTrigger) await this.floatNoteToTop(reminder.noteId).catch(console.error);
      this.update(reminderId, { dueAtUtc: nextDueAtUtc, status: 'pending', repeatRule: reminder.repeatRule }).catch(console.error);
      return;
    }

    if (repeat?.moveToTopOnTrigger) await this.floatNoteToTop(reminder.noteId).catch(console.error);

    this.setReminders(this.reminders$.value.map(r =>
      r.id === reminderId ? { ...r, status: 'fired' as ReminderStatus } : r
    ));
    this.update(reminderId, { status: 'fired' }).catch(console.error);
  }

  private parseRepeatRule(value: string | ReminderRepeatRule | null | undefined): ReminderRepeatRule | null {
    if (!value) return null;
    let parsed: any = value;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value); } catch { return null; }
    }
    const type = parsed?.type;
    if (!['none', 'daily', 'weekly', 'monthly', 'custom_days'].includes(type)) return null;
    const intervalDays = Number(parsed.intervalDays || 0);
    if (type === 'none' && !parsed.moveToTopOnTrigger) return null;
    return {
      type,
      intervalDays: type === 'custom_days' && Number.isFinite(intervalDays) && intervalDays > 0 ? Math.floor(intervalDays) : undefined,
      moveToTopOnTrigger: !!parsed.moveToTopOnTrigger
    };
  }

  private serializeRepeatRule(value: string | ReminderRepeatRule | null | undefined) {
    const parsed = this.parseRepeatRule(value);
    return parsed ? JSON.stringify(parsed) : null;
  }

  private isRepeatingRule(repeat: ReminderRepeatRule | null) {
    return !!repeat && repeat.type !== 'none';
  }

  private nextRepeatDueAt(dueAtUtc: string | null, repeat: ReminderRepeatRule) {
    if (!dueAtUtc) return null;
    if (repeat.type === 'none') return null;
    const next = new Date(dueAtUtc);
    if (Number.isNaN(next.getTime())) return null;
    const now = Date.now();
    let guard = 0;
    while (next.getTime() <= now && guard < 730) {
      guard += 1;
      if (repeat.type === 'daily') next.setUTCDate(next.getUTCDate() + 1);
      else if (repeat.type === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
      else if (repeat.type === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
      else next.setUTCDate(next.getUTCDate() + Math.max(1, Number(repeat.intervalDays || 1)));
    }
    return next.toISOString();
  }

  private async floatNoteToTop(noteId: number | null) {
    if (!noteId || !this.offlineSync.partition) return;
    const notes = await this.offlineStore.listNotes(this.offlineSync.partition);
    const note = notes.find(item => item.id === noteId);
    if (!note?.syncId) return;
    const sorted = notes
      .filter(item => item.id && item.syncId && item.id !== noteId)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.sortOrder || 0) - Number(a.sortOrder || 0));
    const ids = [noteId, ...sorted.map(item => item.id!)];
    const base = Date.now();
    for (let index = 0; index < ids.length; index += 1) {
      const current = notes.find(item => item.id === ids[index]);
      if (!current?.syncId) continue;
      await this.offlineStore.putNote(this.offlineSync.partition, {
        ...current,
        sortOrder: base + ids.length - index,
        updatedAt: new Date().toISOString()
      });
    }
    await this.offlineSync.enqueue('note.reorder', `order-${this.auth.currentUser?.id || 0}`, {
      syncIds: ids.map(id => notes.find(item => item.id === id)?.syncId).filter(Boolean)
    });
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
    if (!isAndroid || (!this.isAndroidGeofenceAvailable() && !this.isAndroidTimeRemindersAvailable()) || typeof document === 'undefined') return;
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

  private isAndroidTimeRemindersAvailable() {
    return isAndroid && !!KeptTimeReminders;
  }

  private nativeLocationReminders(reminders: ReminderI[]): AndroidNativeGeofenceReminder[] {
    return reminders
      .filter(r =>
        r.status === 'pending' &&
        r.noteId &&
        !this.inactiveNoteIds.has(Number(r.noteId)) &&
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

  private nativeTimeReminders(reminders: ReminderI[]): AndroidNativeTimeReminder[] {
    const now = Date.now();
    const nativeReminders: AndroidNativeTimeReminder[] = [];
    for (const reminder of reminders) {
      if (
        reminder.status !== 'pending' ||
        !reminder.dueAtUtc ||
        !reminder.noteId ||
        this.inactiveNoteIds.has(Number(reminder.noteId)) ||
        reminder.locationName ||
        reminder.latitude != null ||
        reminder.longitude != null
      ) continue;
      const fireAtMs = new Date(reminder.dueAtUtc).getTime();
      if (!Number.isFinite(fireAtMs) || fireAtMs <= now) continue;
      nativeReminders.push({
        id: String(reminder.id),
        fireAtMs,
        title: reminder.title || 'Kept reminder',
        body: reminder.body || undefined,
        deepLink: `kept://note/${reminder.noteId}`
      });
    }
    return nativeReminders;
  }

  private syncAndroidTimeReminders(reminders: ReminderI[]) {
    if (!this.isAndroidTimeRemindersAvailable()) return;
    if (this.androidTimeReminderSyncRunning) {
      this.androidTimeReminderSyncQueued = true;
      return;
    }
    this.androidTimeReminderSyncRunning = true;
    const nativeReminders = this.nativeTimeReminders(reminders);
    KeptTimeReminders!.syncTimeReminders({ reminders: nativeReminders })
      .then(result => {
        const invalid = (result.skipped || []).filter(item => item.reason === 'invalid');
        if (invalid.length) console.warn('Some Android time reminders were invalid and skipped', invalid);
        if (result.exact === false) this.promptAndroidExactAlarmPermission();
      })
      .catch(error => console.warn('Android time reminder sync failed', error))
      .finally(() => {
        this.androidTimeReminderSyncRunning = false;
        if (this.androidTimeReminderSyncQueued) {
          this.androidTimeReminderSyncQueued = false;
          this.syncAndroidTimeReminders(this.reminders$.value);
        }
      });
  }

  private cancelAndroidTimeReminder(reminderId: number | string | undefined | null) {
    if (!this.isAndroidTimeRemindersAvailable() || reminderId === undefined || reminderId === null) return;
    const id = String(reminderId);
    if (!id) return;
    KeptTimeReminders!.cancelTimeReminder({ id })
      .catch(error => console.warn('Android time reminder cancellation failed', error));
  }

  private promptAndroidExactAlarmPermission() {
    if (this.androidExactAlarmPromptShown || !this.isAndroidTimeRemindersAvailable()) return;
    this.androidExactAlarmPromptShown = true;
    try {
      (window as any).Snackbar?.show({
        pos: 'bottom-left',
        text: 'Android may delay reminders unless exact alarms are allowed.',
        actionText: 'Settings',
        duration: 8000,
        onActionClick: () => {
          KeptTimeReminders!.openExactAlarmSettings().catch(console.error);
        }
      });
    } catch {}
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
