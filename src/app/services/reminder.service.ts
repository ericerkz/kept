import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom, Subject } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';
import { CalDavSettingsI, GoogleCalendarStatusI, IcsFeedI, ReminderFiredPayload, ReminderI, ReminderStatus } from '../interfaces/reminder';
import { PushNotificationService } from './push-notification.service';

type ReminderCreateData = {
  noteId?: number;
  dueAtUtc?: string;
  timezone?: string;
  title?: string;
  body?: string;
  imageUrl?: string;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
};

type ReminderUpdateData = {
  status?: ReminderStatus;
  dueAtUtc?: string;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
};

@Injectable({ providedIn: 'root' })
export class ReminderService {
  reminders$ = new BehaviorSubject<ReminderI[]>([]);
  firedReminder$ = new Subject<ReminderFiredPayload>();

  private readonly apiUrl = environment.apiUrl;
  private reminderTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private http: HttpClient, private auth: AuthService, private push: PushNotificationService) {
    this.auth.currentUser$.subscribe(user => {
      if (user) this.load().catch(console.error);
      else this.setReminders([]);
    });
    this.listenForServiceWorkerMessages();
  }

  async load() {
    const reminders = await firstValueFrom(
      this.http.get<ReminderI[]>(`${this.apiUrl}/reminders`, { headers: this.auth.authHeaders() })
    );
    this.setReminders(reminders);
  }

  async create(data: ReminderCreateData) {
    try {
      const reminder = await firstValueFrom(
        this.http.post<ReminderI>(`${this.apiUrl}/reminders`, data, { headers: this.auth.authHeaders() })
      );
      await this.load();
      return reminder;
    } catch (error: any) {
      if (error?.status === 409 && data.noteId) {
        const retry = await this.retryCreateAsUpdate(data).catch(retryError => {
          console.warn('Reminder 409 retry failed (non-fatal):', retryError?.message || retryError);
          return null;
        });
        if (retry) return retry;
      }
      // Server-side upsert handles noteId conflicts transparently, but if a
      // network error or stale 409 still slips through, log and return null
      // so callers that treat this as fire-and-forget aren't affected.
      console.warn('Reminder create failed (non-fatal):', error?.message || error);
      return null;
    }
  }

  async update(id: number, data: ReminderUpdateData) {
    const reminder = await firstValueFrom(
      this.http.patch<ReminderI>(`${this.apiUrl}/reminders/${id}`, data, { headers: this.auth.authHeaders() })
    );
    await this.load();
    return reminder;
  }

  async delete(id: number) {
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}/reminders/${id}`, { headers: this.auth.authHeaders() })
    );
    await this.load();
  }

  getActiveForNote(noteId: number): ReminderI | undefined {
    return this.reminders$.value.find(r => r.noteId === noteId && r.status === 'pending');
  }

  private async retryCreateAsUpdate(data: ReminderCreateData): Promise<ReminderI | null> {
    if (!data.noteId) return null;
    await this.load();
    const existing = this.getActiveForNote(data.noteId);
    if (!existing) return null;
    return this.update(existing.id, {
      dueAtUtc: data.dueAtUtc,
      locationName: data.locationName,
      latitude: data.latitude,
      longitude: data.longitude,
      radiusMeters: data.radiusMeters
    });
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

  iosNeedsHomeScreenInstall() {
    return this.push.iosNeedsHomeScreenInstall();
  }

  isIos() { return this.push.isIos(); }
  isStandalone() { return this.push.isStandalone(); }

  private setReminders(reminders: ReminderI[]) {
    this.reminders$.next(reminders);
    this.schedulePendingReminders(reminders);
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
