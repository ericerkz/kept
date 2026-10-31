import { HttpClient } from '@angular/common/http';
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';

export interface ManagedHostingNotice {
  kind: 'ending' | 'payment_problem';
  endsAt: string | null;
  deletesAt: string | null;
  dismissible: boolean;
  actionUrl: string;
}

export interface ManagedHostingInfo {
  managed: boolean;
  providerName: string;
  accountUrl: string;
  externalBackups: boolean;
  quotaBytes: number | null;
  notice: ManagedHostingNotice | null;
}

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number | null;
  remainingBytes: number | null;
  percentUsed: number | null;
}

const UNMANAGED: ManagedHostingInfo = {
  managed: false,
  providerName: '',
  accountUrl: '',
  externalBackups: false,
  quotaBytes: null,
  notice: null
};

// Generic managed-hosting metadata (KEPT_MANAGED_* env vars). Any
// provider can set these; this service holds no provider-specific
// business logic, just the client side of the public primitive.
@Injectable({ providedIn: 'root' })
export class ManagedHostingService implements OnDestroy {
  private readonly apiUrl = environment.apiUrl;
  readonly info$ = new BehaviorSubject<ManagedHostingInfo>(UNMANAGED);
  private inFlight: Promise<ManagedHostingInfo> | null = null;
  private lastReadAt = -Infinity;
  private destroyed = false;
  private appHandles: PluginListenerHandle[] = [];
  private foreground = () => { if (!this.destroyed) void this.info(); };
  private visibilityChanged = () => { if (document.visibilityState === 'visible') this.foreground(); };

  constructor(private http: HttpClient, private auth: AuthService, private zone: NgZone) {
    window.addEventListener('focus', this.foreground);
    document.addEventListener('visibilitychange', this.visibilityChanged);
    void this.auth.workspace.ready.then(() => this.foreground()).catch(() => {});
    void this.bindNativeForeground();
  }

  private async bindNativeForeground() {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('App')) return;
    const app = registerPlugin<{
      addListener(event: 'resume' | 'appStateChange', callback: (state?: { isActive?: boolean }) => void): Promise<PluginListenerHandle>;
    }>('App');
    for (const event of ['resume', 'appStateChange'] as const) {
      try {
        const handle = await app.addListener(event, state => { if (event === 'resume' || state?.isActive) this.foreground(); });
        if (this.destroyed) void handle.remove();
        else this.appHandles.push(handle);
      } catch { /* Browser lifecycle events remain available in older shells. */ }
    }
  }

  info(): Promise<ManagedHostingInfo> {
    if (this.auth.isLocal) return Promise.resolve(UNMANAGED);
    // A fresh native install has not chosen a server yet.
    if (Capacitor.isNativePlatform() && !/^https?:\/\//i.test(this.apiUrl)) return Promise.resolve(UNMANAGED);
    if (this.inFlight) return this.inFlight;
    if (this.destroyed || Date.now() - this.lastReadAt < 30 * 60 * 1000) return Promise.resolve(this.info$.value);
    this.lastReadAt = Date.now();
    this.inFlight = firstValueFrom(this.http.get<ManagedHostingInfo>(`${this.apiUrl}/settings/managed-hosting`))
      .then(value => {
        // Older servers have no notice field.
        const info = { ...value, notice: value.notice || null };
        if (!this.destroyed && !this.auth.isLocal) this.zone.run(() => this.info$.next(info));
        return info;
      })
      .catch(() => this.info$.value)
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  ngOnDestroy() {
    this.destroyed = true;
    window.removeEventListener('focus', this.foreground);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    for (const handle of this.appHandles) void handle.remove();
  }

  async storageUsage(): Promise<StorageUsage | null> {
    if (this.auth.isLocal || !this.auth.currentUser) return null;
    try {
      return await firstValueFrom(this.http.get<StorageUsage>(`${this.apiUrl}/settings/storage`, { headers: this.auth.authHeaders() }));
    } catch {
      return null;
    }
  }
}
