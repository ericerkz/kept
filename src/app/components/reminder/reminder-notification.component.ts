import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { ReminderFiredPayload } from 'src/app/interfaces/reminder';
import { ReminderService } from 'src/app/services/reminder.service';

@Component({
  selector: 'app-reminder-notification',
  templateUrl: './reminder-notification.component.html',
  styleUrls: ['./reminder-notification.component.scss'],
  standalone: false
})
export class ReminderNotificationComponent implements OnInit, OnDestroy {
  notification: ReminderFiredPayload | null = null;
  private sub?: Subscription;

  constructor(private reminderService: ReminderService) {}

  ngOnInit() {
    this.sub = this.reminderService.firedReminder$.subscribe(payload => {
      const cleanPayload = {
        ...payload,
        title: this.cleanText(payload.title),
        body: this.cleanText(payload.body),
        imageUrl: payload.imageUrl || null
      };
      this.notification = cleanPayload;
      this.playReminderSound();
      this.showBrowserNotification(cleanPayload);
    });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  dismiss() {
    if (!this.notification) return;
    if (this.notification.reminderId > 0) {
      this.reminderService.update(this.notification.reminderId, { status: 'dismissed' }).catch(console.error);
    }
    this.notification = null;
  }

  snooze() {
    if (!this.notification) return;
    const snoozeUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    if (this.notification.reminderId > 0) {
      this.reminderService.update(this.notification.reminderId, { status: 'pending', dueAtUtc: snoozeUntil }).catch(console.error);
    }
    this.notification = null;
  }

  private showBrowserNotification(payload: ReminderFiredPayload) {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    // The SW push handler already called showNotification() for push-fired
    // events; skip the in-page duplicate. For locally-fired (timer) events
    // we MUST surface the OS notification ourselves, otherwise desktop users
    // see nothing when the page is in another tab.
    if (payload.source === 'sw-push') return;

    const title = this.cleanText(payload.title) || 'Reminder';
    const body = this.cleanText(payload.body);
    try {
      new Notification(title, {
        body: body || undefined,
        icon: '/assets/images/keep2x.png',
        tag: `kept-reminder-${payload.reminderId}`
      });
    } catch {
      // iOS Safari throws if Notification() is constructed in a page context;
      // the SW notification handles iOS anyway.
    }
  }

  private cleanText(value: string | null) {
    const div = document.createElement('div');
    div.innerHTML = value || '';
    return (div.textContent || div.innerText || '').trim();
  }

  private playReminderSound() {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      const ctx = new AudioContextCtor();
      const notes = [
        { frequency: 659.25, start: 0, duration: 0.09 },
        { frequency: 783.99, start: 0.1, duration: 0.11 },
        { frequency: 1046.5, start: 0.22, duration: 0.16 }
      ];

      notes.forEach(note => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = note.frequency;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + note.start);
        gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + note.start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + note.start + note.duration);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(ctx.currentTime + note.start);
        oscillator.stop(ctx.currentTime + note.start + note.duration + 0.02);
      });

      setTimeout(() => ctx.close().catch(() => undefined), 700);
    } catch (error) {
      console.log(error);
    }
  }
}
