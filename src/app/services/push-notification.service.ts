import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';

declare var Snackbar: any;

@Injectable({ providedIn: 'root' })
export class PushNotificationService {
  private readonly apiUrl = environment.apiUrl;
  private isRegistering = false;

  constructor(private http: HttpClient, private auth: AuthService) {
    this.auth.currentUser$.subscribe(user => {
      if (user && this.isSupported() && Notification.permission === 'granted') {
        this.ensureSubscribed().catch(console.error);
      }
    });
  }

  isIos() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const platform = (navigator as any).platform || '';
    return /iPad|iPhone|iPod/.test(ua)
      || (platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
  }

  isStandalone() {
    if (typeof window === 'undefined') return false;
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || (navigator as any).standalone === true;
  }

  iosNeedsHomeScreenInstall() {
    return this.isIos() && !this.isStandalone();
  }

  /**
   * Must be called from inside a user-gesture handler (e.g. a click) on iOS.
   * Returns the resulting permission state.
   */
  async requestPermissionFromGesture(): Promise<NotificationPermission | 'unsupported'> {
    if (!this.isSupported()) return 'unsupported';
    // iOS Web Push only works on HTTPS origins. On http:// it silently denies
    // and there's no way to re-prompt — bail early so the failure is loud.
    if (!(window as any).isSecureContext) {
      console.warn('[push] not a secure context — iOS Web Push requires HTTPS.');
      return 'denied';
    }
    if (Notification.permission === 'granted') {
      this.ensureSubscribed().catch(console.error);
      return 'granted';
    }
    if (Notification.permission === 'denied') return 'denied';
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      this.ensureSubscribed().catch(console.error);
    }
    return permission;
  }

  async ensureSubscribed() {
    if (this.isRegistering || !this.auth.token) return;
    if (!this.isSupported()) return;
    // iOS only allows web push when the app is launched in standalone (PWA)
    // mode. Subscribing inside a Safari tab on iOS produces a registration
    // that iOS does NOT surface in Settings → Notifications and that never
    // delivers, so refuse it outright.
    if (this.isIos() && !this.isStandalone()) return;
    this.isRegistering = true;

    try {
      if (Notification.permission !== 'granted') return;

      // Wait for the SW to reach `activated` before subscribing — iOS
      // refuses pushManager.subscribe() against an installing/waiting worker.
      const registration = await navigator.serviceWorker.register('/kept-push-sw.js');
      if (registration.installing || registration.waiting) {
        await new Promise<void>(resolve => {
          const sw = registration.installing || registration.waiting;
          if (!sw || sw.state === 'activated') return resolve();
          sw.addEventListener('statechange', () => {
            if (sw.state === 'activated') resolve();
          });
          setTimeout(resolve, 4000);
        });
      }
      await navigator.serviceWorker.ready;

      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array(await this.getPublicKey())
      });

      await firstValueFrom(this.http.post(
        `${this.apiUrl}/push/subscriptions`,
        { subscription: subscription.toJSON() },
        { headers: this.auth.authHeaders() }
      ));
    } finally {
      this.isRegistering = false;
    }
  }

  async requestPermissionWithReason(reason: string) {
    if (!this.isSupported()) return;
    
    if (Notification.permission === 'granted') {
      await this.ensureSubscribed();
      return;
    }

    if (Notification.permission === 'denied') {
      console.warn('Notification permission was previously denied.');
      return;
    }

    // Use the snackbar to get a user gesture
    if (typeof Snackbar !== 'undefined') {
      Snackbar.show({
        pos: 'bottom-left',
        text: reason,
        actionText: 'Enable',
        duration: 0, // Keep it visible until they act
        onActionClick: async () => {
          const permission = await Notification.requestPermission();
          if (permission === 'granted') {
            await this.ensureSubscribed();
            Snackbar.show({ pos: 'bottom-left', text: 'Notifications enabled!', duration: 3000 });
          }
        }
      });
    } else {
      // Fallback to confirm if Snackbar isn't ready
      if (confirm(reason)) {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          await this.ensureSubscribed();
        }
      }
    }
  }

  async unsubscribe() {
    if (!this.isSupported()) return;
    const registration = await navigator.serviceWorker.getRegistration('/kept-push-sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;

    await firstValueFrom(this.http.delete(`${this.apiUrl}/push/subscriptions`, {
      body: { endpoint: subscription.endpoint },
      headers: this.auth.authHeaders()
    }));
    await subscription.unsubscribe();
  }

  private async getPublicKey() {
    const result = await firstValueFrom(this.http.get<{ publicKey: string }>(
      `${this.apiUrl}/push/vapid-public-key`,
      { headers: this.auth.authHeaders() }
    ));
    return result.publicKey;
  }

  private isSupported() {
    return typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
  }

  private urlBase64ToUint8Array(base64String: string) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
  }
}
