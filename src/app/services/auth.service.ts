import { createNoteHtmlContainer, sanitizeNoteHtml } from '../utils/note-html';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { firstValueFrom, BehaviorSubject, timeout } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthSessionI, UserI, UserRole, UserTheme } from '../interfaces/users';

type LoginResponse = {
  token?: string
  csrfToken?: string
  user: UserI
}

type ThemeAppPlugin = {
  addListener(event: 'resume' | 'appStateChange', callback: (state?: { isActive?: boolean }) => void): Promise<PluginListenerHandle>
}

export interface McpAccessSettings {
  enabled: boolean
  allowLockedNotes: boolean
  allowPermanentDelete: boolean
  token: { prefix: string; createdAt: string; lastUsedAt: string | null } | null
  accessToken?: string
}

export interface OAuthConnection {
  id: number
  clientId: string
  clientName: string
  resource: string
  scopes: string[]
  authorizedAt: string
  lastUsedAt: string | null
}

export interface OAuthAccessSettings {
  enabled: boolean
  allowLockedNotes: boolean
  allowPermanentDelete: boolean
  connections: OAuthConnection[]
}

export interface ExternalAccessCapabilities {
  allowLockedNotes: boolean
  allowPermanentDelete: boolean
}

export interface OidcConfig {
  enabled: boolean
  name: string
}

export interface OidcLinkStatus {
  enabled: boolean
  providerName: string
  connected: boolean
  identityEmail: string
  connectedAt: string | null
}

@Injectable({
  providedIn: 'root'
})
export class AuthService implements OnDestroy {
  private readonly sessionKey = 'gk_session';
  private readonly apiUrl = environment.apiUrl;
  readonly usesBrowserSession = !Capacitor.isNativePlatform();
  private readonly systemThemeQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  private readonly systemThemeChanged = () => {
    if (!this.destroyed && this.followsSystemTheme) this.zone.run(() => this.applyTheme());
  };
  private readonly themeVisibilityChanged = () => {
    if (document.visibilityState === 'visible') this.systemThemeChanged();
  };
  private themeResumeHandles: PluginListenerHandle[] = [];
  private destroyed = false;
  private csrfToken = '';
  private csrfRefresh?: Promise<unknown>;
  private legacyBrowserToken = '';
  private lastSessionExpiredNoticeAt = 0;
  private suppressSessionExpiredUntil = 0;
  currentUser$ = new BehaviorSubject<AuthSessionI | null>(this.getStoredSession());
  private mediaUrls = new Map<string, string>();
  private mediaCanonical = new Map<string, string>();
  private mediaRequests = new Map<string, Promise<string>>();

  constructor(private http: HttpClient, private zone: NgZone) {
    this.systemThemeQuery?.addEventListener('change', this.systemThemeChanged);
    window.addEventListener('focus', this.systemThemeChanged);
    document.addEventListener('visibilitychange', this.themeVisibilityChanged);
    void this.bindThemeResume();
    let owner = this.token;
    this.currentUser$.subscribe(() => {
      this.applyTheme();
      if (owner === this.token) return;
      owner = this.token;
      for (const url of this.mediaUrls.values()) URL.revokeObjectURL(url);
      this.mediaUrls.clear();
      this.mediaCanonical.clear();
      this.mediaRequests.clear();
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.systemThemeQuery?.removeEventListener('change', this.systemThemeChanged);
    window.removeEventListener('focus', this.systemThemeChanged);
    document.removeEventListener('visibilitychange', this.themeVisibilityChanged);
    for (const handle of this.themeResumeHandles) void handle.remove();
    this.themeResumeHandles = [];
  }

  private async bindThemeResume() {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('App')) return;
    const app = ((window as any).Capacitor?.Plugins?.App || registerPlugin<ThemeAppPlugin>('App')) as ThemeAppPlugin;
    for (const event of ['resume', 'appStateChange'] as const) {
      try {
        const handle = await app.addListener(event, state => {
          if (event === 'resume' || state?.isActive === true) this.systemThemeChanged();
        });
        if (this.destroyed) await handle.remove();
        else this.themeResumeHandles.push(handle);
      } catch (error) {
        console.warn('Could not register theme resume listener', error);
      }
    }
  }

  get followsSystemTheme() {
    return this.currentUser ? this.currentUser.followSystemTheme === true : true;
  }

  get effectiveTheme(): UserTheme {
    if (this.followsSystemTheme) return this.systemThemeQuery?.matches ? 'dark' : 'light';
    return this.currentUser?.theme || 'light';
  }

  get currentUser() {
    return this.currentUser$.value;
  }

  get token() {
    return this.currentUser?.token || '';
  }

  get isAdmin() {
    return this.currentUser?.role === 'admin';
  }

  authHeaders() {
    return this.usesBrowserSession
      ? new HttpHeaders(this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {})
      : new HttpHeaders({ Authorization: `Bearer ${this.token}` });
  }

  async initializeBrowserSession() {
    if (!this.usesBrowserSession) return;
    try {
      const result = await this.refreshBrowserSession();
      if (this.legacyBrowserToken && !result.authenticated) {
        const adopted = await firstValueFrom(this.http.post<LoginResponse>(`${this.apiUrl}/auth/browser/adopt`, {}, {
          headers: this.authHeaders().set('Authorization', `Bearer ${this.legacyBrowserToken}`)
        }).pipe(timeout(10000)));
        this.storeLoginResult(adopted);
      } else if (result.user) {
        this.storeLoginResult({ user: result.user, csrfToken: result.csrfToken });
      } else {
        localStorage.removeItem(this.sessionKey);
        this.currentUser$.next(null);
      }
    } catch (error) {
      // Keep nonsecret account metadata for the existing offline workspace.
      // An expired/revoked legacy session still requires signing in again.
      if (error instanceof HttpErrorResponse && error.status === 401) {
        localStorage.removeItem(this.sessionKey);
        this.currentUser$.next(null);
      }
    } finally {
      this.legacyBrowserToken = '';
    }
  }

  private async refreshBrowserSession() {
    const result = await firstValueFrom(this.http.get<{
      authenticated: boolean; user: UserI | null; csrfToken: string
    }>(`${this.apiUrl}/auth/browser/session`).pipe(timeout(10000)));
    this.csrfToken = result.csrfToken;
    return result;
  }

  async ensureBrowserCsrf() {
    if (!this.csrfToken) {
      if (!this.csrfRefresh) {
        this.csrfRefresh = this.refreshBrowserSession().finally(() => { this.csrfRefresh = undefined; });
      }
      await this.csrfRefresh;
    }
    return this.csrfToken;
  }

  isAuthExpiredError(error: unknown) {
    return error instanceof HttpErrorResponse && error.status === 401;
  }

  notifySessionExpired(error?: unknown) {
    if (error && !this.isAuthExpiredError(error)) return false;
    if (Date.now() < this.suppressSessionExpiredUntil) return true;
    const now = Date.now();
    if (now - this.lastSessionExpiredNoticeAt < 4000) return true;
    this.lastSessionExpiredNoticeAt = now;
    try {
      (window as any).Snackbar?.show({
        pos: 'bottom-left',
        text: 'Session expired. Please sign in again before saving.',
        duration: 5200
      });
    } catch {}
    return true;
  }

  suppressSessionExpiredNotice(durationMs = 8000) {
    this.suppressSessionExpiredUntil = Math.max(this.suppressSessionExpiredUntil, Date.now() + durationMs);
  }

  canonicalImageUrl(value: string) {
    const raw = String(value || '').trim();
    const mediaCanonical = this.mediaCanonical.get(raw);
    if (mediaCanonical) return mediaCanonical;
    const offlineMap = (window as typeof window & { __keptOfflineMediaCanonical?: Map<string, string> }).__keptOfflineMediaCanonical;
    const offlineCanonical = offlineMap?.get(raw);
    if (offlineCanonical) return offlineCanonical;
    if (!raw || raw.startsWith('data:')) return raw;
    let pathname = raw;
    try {
      const parsed = new URL(raw, window.location.origin);
      const allowedOrigins = new Set([window.location.origin]);
      if (this.apiUrl.startsWith('http')) allowedOrigins.add(new URL(this.apiUrl).origin);
      if (!allowedOrigins.has(parsed.origin)) return raw;
      pathname = parsed.pathname;
    } catch {}
    const match = pathname.match(/^(?:\/uploads\/|\/api\/uploads\/images\/)([^/?#]+)$/);
    if (!match) return raw;
    return `/api/uploads/images/${match[1]}`;
  }

  authenticatedImageUrl(value: string) {
    const raw = String(value || '').trim();
    const offlineMap = (window as typeof window & { __keptOfflineMediaCanonical?: Map<string, string> }).__keptOfflineMediaCanonical;
    if (offlineMap?.has(raw)) return raw;
    const canonical = this.canonicalImageUrl(value);
    if (!canonical.startsWith('/api/uploads/images/')) return canonical;
    const imageUrl = this.apiUrl.startsWith('http') ? `${this.apiUrl}${canonical.slice('/api'.length)}` : canonical;
    return this.mediaUrls.get(imageUrl) || imageUrl;
  }

  // Native image elements cannot attach Authorization headers. Fetch through
  // HttpClient (including gateway headers) and display a local blob instead.
  // Callers prepare images before inserting their HTML into a live document.
  async prepareImageUrl(value: string): Promise<string> {
    const url = this.authenticatedImageUrl(value);
    if (this.usesBrowserSession || !this.isProtectedMediaUrl(url)) return url;
    const existing = this.mediaUrls.get(url);
    if (existing) return existing;
    if (!this.mediaRequests.has(url)) {
      const token = this.token;
      const request = this.fetchMediaBlob(url).then(async blob => {
        // A blob URL has the app's origin and does not retain the proxy's CSP.
        // Rasterize proxy thumbnails so an SVG cannot become an executable
        // document if someone opens its local rendering URL directly.
        if (new URL(url, window.location.origin).pathname.endsWith('/proxy-image')) blob = await this.rasterizeThumbnail(blob);
        if (!token || token !== this.token) throw new Error('Session changed while loading image.');
        const objectUrl = URL.createObjectURL(blob);
        this.mediaUrls.set(url, objectUrl);
        this.mediaCanonical.set(objectUrl, this.canonicalImageUrl(url));
        return objectUrl;
      }).finally(() => { if (this.mediaRequests.get(url) === request) this.mediaRequests.delete(url); });
      this.mediaRequests.set(url, request);
    }
    return this.mediaRequests.get(url)!;
  }

  private async rasterizeThumbnail(blob: Blob): Promise<Blob> {
    const source = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      // Bound the thumbnail allocation while retaining aspect ratio.
      const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Could not render thumbnail.')), 'image/png'));
    } finally { URL.revokeObjectURL(source); }
  }

  private isProtectedMediaUrl(value: string) {
    try {
      const target = new URL(value, window.location.origin);
      const base = new URL(this.apiUrl, window.location.origin);
      return target.origin === base.origin &&
        (target.pathname.startsWith(base.pathname + '/uploads/images/') || target.pathname === base.pathname + '/proxy-image');
    } catch { return false; }
  }

  async fetchMediaBlob(value: string) {
    const url = this.authenticatedImageUrl(value);
    // Never send a Kept credential to an external image host.
    return firstValueFrom(this.http.get(url, {
      headers: this.isProtectedMediaUrl(url) ? this.authHeaders() : undefined,
      responseType: 'blob'
    }).pipe(timeout(15000)));
  }

  authenticatedImageHtml(html: string) {
    const div = createNoteHtmlContainer();
    div.innerHTML = sanitizeNoteHtml(html || '');
    div.querySelectorAll<HTMLImageElement>('img[src]').forEach(img => {
      img.setAttribute('src', this.authenticatedImageUrl(img.getAttribute('src') || img.src));
    });
    return div.innerHTML;
  }

  canonicalImageHtml(html: string) {
    const div = createNoteHtmlContainer();
    div.innerHTML = sanitizeNoteHtml(html || '');
    div.querySelectorAll<HTMLImageElement>('img[src]').forEach(img => {
      img.setAttribute('src', this.canonicalImageUrl(img.getAttribute('src') || img.src));
    });
    return div.innerHTML;
  }

  async hasUsers() {
    const result = await firstValueFrom(this.http.get<{ hasUsers: boolean }>(`${this.apiUrl}/setup/status`));
    return result.hasUsers;
  }

  async listUsers() {
    return await firstValueFrom(this.http.get<UserI[]>(`${this.apiUrl}/users`, { headers: this.authHeaders() }));
  }

  async createInitialAdmin(username: string, displayName: string, password: string, totpSecret?: string, totpToken?: string) {
    const payload: any = { username, displayName, password };
    if (totpSecret && totpToken) {
      payload.totpSecret = totpSecret;
      payload.totpToken = totpToken;
    }
    return await firstValueFrom(this.http.post<{ user: UserI, backupCodes: string[] | null }>(`${this.apiUrl}/setup/admin`, payload));
  }

  async createManagedUser(username: string, displayName: string, password: string, role: UserRole, email?: string) {
    return await firstValueFrom(this.http.post<UserI>(
      `${this.apiUrl}/users`,
      { username, displayName, password, role, email },
      { headers: this.authHeaders() }
    ));
  }

  async deleteUser(user: UserI) {
    if (!user.id) throw new Error('User is missing an id.');
    await firstValueFrom(this.http.delete(`${this.apiUrl}/users/${user.id}`, { headers: this.authHeaders() }));
  }

  async deleteOwnAccount(currentPassword: string, confirmation: string) {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/users/me`, {
      headers: this.authHeaders(),
      body: { currentPassword, confirmation }
    }));
    localStorage.removeItem(this.sessionKey);
    this.currentUser$.next(null);
  }

  async generateSetup2fa(username?: string) {
    const params = username ? `?username=${encodeURIComponent(username)}` : '';
    return await firstValueFrom(this.http.get<{ secret: string, qrCodeUrl: string }>(`${this.apiUrl}/setup/2fa/generate${params}`));
  }

  async generateSettings2fa() {
    return await firstValueFrom(this.http.get<{ secret: string, qrCodeUrl: string }>(`${this.apiUrl}/auth/2fa/generate`, { headers: this.authHeaders() }));
  }

  async enable2fa(secret: string, token: string) {
    return await firstValueFrom(this.http.post<{ success: boolean, backupCodes: string[] }>(`${this.apiUrl}/auth/2fa/enable`, { secret, token }, { headers: this.authHeaders() }));
  }

  async disable2fa() {
    return await firstValueFrom(this.http.delete(`${this.apiUrl}/auth/2fa/disable`, { headers: this.authHeaders() }));
  }

  async login(username: string, password: string, totpToken?: string) {
    let result: LoginResponse;
    try {
      const payload: any = { username, password };
      if (totpToken) payload.totpToken = totpToken;
      if (this.usesBrowserSession) await this.refreshBrowserSession();
      const route = this.usesBrowserSession ? 'browser/login' : 'login';
      result = await firstValueFrom(this.http.post<LoginResponse>(`${this.apiUrl}/auth/${route}`, payload, { headers: this.authHeaders() }));
    } catch (error: any) {
      if (error?.error?.requires2FA) {
        throw { requires2FA: true };
      }
      if (error?.status === 403) {
        throw error;
      }
      return false;
    }

    this.storeLoginResult(result);
    return true;
  }

  async getOidcConfig() {
    return await firstValueFrom(this.http.get<OidcConfig>(`${this.apiUrl}/auth/oidc/config`));
  }

  startOidcLogin(oauthRequest = '') {
    const params = new URLSearchParams();
    if (oauthRequest) params.set('oauth_request', oauthRequest);
    const returnUrl = this.nativeOidcReturnUrl();
    if (returnUrl) params.set('return_url', returnUrl);
    const query = params.toString() ? `?${params.toString()}` : '';
    window.location.assign(`${this.apiUrl}/auth/oidc/start${query}`);
  }

  async exchangeOidcCode(code: string) {
    if (this.usesBrowserSession) await this.refreshBrowserSession();
    const route = this.usesBrowserSession ? 'browser/oidc/exchange' : 'oidc/exchange';
    const result = await firstValueFrom(this.http.post<LoginResponse>(`${this.apiUrl}/auth/${route}`, { code }, { headers: this.authHeaders() }));
    this.storeLoginResult(result);
  }

  async getOidcLinkStatus() {
    return await firstValueFrom(this.http.get<OidcLinkStatus>(
      `${this.apiUrl}/auth/oidc/link/status`,
      { headers: this.authHeaders() }
    ));
  }

  async startOidcLink() {
    const returnUrl = this.nativeOidcReturnUrl();
    return await firstValueFrom(this.http.post<{ url: string }>(
      `${this.apiUrl}/auth/oidc/link/start`,
      returnUrl ? { return_url: returnUrl } : {},
      { headers: this.authHeaders() }
    ));
  }

  async disconnectOidcLink() {
    await firstValueFrom(this.http.delete(
      `${this.apiUrl}/auth/oidc/link`,
      { headers: this.authHeaders() }
    ));
  }

  private storeLoginResult(result: LoginResponse) {
    if (this.usesBrowserSession) this.csrfToken = result.csrfToken || this.csrfToken;
    const session: AuthSessionI = {
      token: this.usesBrowserSession ? '' : result.token || '',
      id: result.user.id!,
      username: result.user.username,
      displayName: result.user.displayName,
      role: result.user.role,
      theme: result.user.theme || 'light',
      followSystemTheme: result.user.followSystemTheme === true,
      avatarDataUrl: result.user.avatarDataUrl || '',
      avatarPreset: result.user.avatarPreset || 'cat',
      showPastReminders: result.user.showPastReminders === true,
      totpEnabled: result.user.totpEnabled,
      hasBackupCodes: result.user.hasBackupCodes,
      demoNotesCreatedAt: result.user.demoNotesCreatedAt ?? null
    };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.currentUser$.next(session);
  }

  private nativeOidcReturnUrl() {
    return Capacitor.isNativePlatform() ? 'kept://auth/oidc' : '';
  }

  async updateTheme(theme: UserTheme) {
    await this.updateAccountPreferences({ theme, followSystemTheme: false });
  }

  async setFollowSystemTheme(enabled: boolean) {
    await this.updateAccountPreferences({
      followSystemTheme: enabled,
      ...(!enabled ? { theme: this.effectiveTheme } : {})
    });
  }

  async loadAccountPreferences() {
    const user = await firstValueFrom(this.http.get<UserI>(
      `${this.apiUrl}/users/me/preferences`,
      { headers: this.authHeaders() }
    ));
    this.mergeAccountPreferences(user);
    return user;
  }

  async updateAccountPreferences(patch: { theme?: UserTheme; followSystemTheme?: boolean; showPastReminders?: boolean }) {
    const user = await firstValueFrom(this.http.patch<UserI>(
      `${this.apiUrl}/users/me/preferences`,
      patch,
      { headers: this.authHeaders() }
    ));
    this.mergeAccountPreferences(user);
    return user;
  }

  async getMcpAccessSettings() {
    return await firstValueFrom(this.http.get<McpAccessSettings>(
      `${this.apiUrl}/users/me/mcp-access`,
      { headers: this.authHeaders() }
    ));
  }

  async enableMcpAccess() {
    return await firstValueFrom(this.http.post<McpAccessSettings>(
      `${this.apiUrl}/users/me/mcp-access/enable`,
      {},
      { headers: this.authHeaders() }
    ));
  }

  async updateMcpAccessSettings(patch: { allowLockedNotes?: boolean; allowPermanentDelete?: boolean }) {
    return await firstValueFrom(this.http.patch<McpAccessSettings>(
      `${this.apiUrl}/users/me/mcp-access`,
      patch,
      { headers: this.authHeaders() }
    ));
  }

  async disableMcpAccess() {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/users/me/mcp-access`, { headers: this.authHeaders() }));
  }

  async getOAuthAccessSettings() {
    return await firstValueFrom(this.http.get<OAuthAccessSettings>(
      `${this.apiUrl}/users/me/oauth-access`,
      { headers: this.authHeaders() }
    ));
  }

  async enableOAuthAccess() {
    return await firstValueFrom(this.http.post<OAuthAccessSettings>(
      `${this.apiUrl}/users/me/oauth-access/enable`,
      {},
      { headers: this.authHeaders() }
    ));
  }

  async disableOAuthAccess() {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/users/me/oauth-access`, { headers: this.authHeaders() }));
  }

  async revokeOAuthConnection(grantId: number) {
    await firstValueFrom(this.http.delete(
      `${this.apiUrl}/users/me/oauth-access/connections/${grantId}`,
      { headers: this.authHeaders() }
    ));
  }

  async updateExternalAccessCapabilities(patch: Partial<ExternalAccessCapabilities>) {
    return await firstValueFrom(this.http.patch<ExternalAccessCapabilities>(
      `${this.apiUrl}/users/me/external-access/capabilities`,
      patch,
      { headers: this.authHeaders() }
    ));
  }

  private mergeAccountPreferences(user: UserI) {
    const current = this.currentUser;
    if (!current) return;
    const session = {
      ...current,
      theme: user.theme || current.theme,
      followSystemTheme: user.followSystemTheme ?? current.followSystemTheme ?? false,
      showPastReminders: user.showPastReminders === true
    };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.currentUser$.next(session);
  }

  async updateProfile(displayName: string, avatarDataUrl: string, avatarPreset?: string) {
    const user = await firstValueFrom(this.http.patch<UserI>(
      `${this.apiUrl}/users/me/profile`,
      { displayName, avatarDataUrl, avatarPreset },
      { headers: this.authHeaders() }
    ));
    const current = this.currentUser;
    if (!current) return;

    const session = {
      ...current,
      displayName: user.displayName,
      avatarDataUrl: user.avatarDataUrl || '',
      avatarPreset: user.avatarPreset || current.avatarPreset || 'cat'
    };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.currentUser$.next(session);
  }

  async markDemoNotesCreated() {
    const user = await firstValueFrom(this.http.post<UserI>(
      `${this.apiUrl}/users/me/mark-demo-notes-created`,
      {},
      { headers: this.authHeaders() }
    ));
    const current = this.currentUser;
    if (!current) return user;
    const session = { ...current, demoNotesCreatedAt: user.demoNotesCreatedAt || new Date().toISOString() };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.currentUser$.next(session);
    return user;
  }

  async logout() {
    if (this.currentUser) {
      try {
        await firstValueFrom(this.http.post(`${this.apiUrl}/auth/logout`, {}, { headers: this.authHeaders() }));
      } catch (error) {
        if (this.usesBrowserSession && !this.isAuthExpiredError(error)) throw error;
      }
    }
    localStorage.removeItem(this.sessionKey);
    this.currentUser$.next(null);
  }

  async resetOwnPassword(currentPassword: string, newPassword: string) {
    return await firstValueFrom(this.http.patch<{ success: boolean }>(
      `${this.apiUrl}/users/me/password`,
      { currentPassword, newPassword },
      { headers: this.authHeaders() }
    ));
  }

  async adminResetPassword(userId: number, newPassword: string) {
    return await firstValueFrom(this.http.patch<{ success: boolean }>(
      `${this.apiUrl}/users/${userId}/reset-password`,
      { newPassword },
      { headers: this.authHeaders() }
    ));
  }

  async adminToggleUserEnabled(userId: number, enabled: boolean) {
    return await firstValueFrom(this.http.patch<UserI>(
      `${this.apiUrl}/users/${userId}/toggle-enabled`,
      { enabled },
      { headers: this.authHeaders() }
    ));
  }

  async getRegistrationSettings() {
    return await firstValueFrom(this.http.get<{ selfRegistrationEnabled: boolean, requireApproval: boolean }>(
      `${this.apiUrl}/settings/registration`
    ));
  }

  async saveRegistrationSettings(settings: { selfRegistrationEnabled?: boolean, requireApproval?: boolean }) {
    return await firstValueFrom(this.http.patch<{ selfRegistrationEnabled: boolean, requireApproval: boolean }>(
      `${this.apiUrl}/settings/registration`,
      settings,
      { headers: this.authHeaders() }
    ));
  }

  async register(username: string, displayName: string, email: string, password: string) {
    return await firstValueFrom(this.http.post<{ success: boolean, needsApproval: boolean, message: string }>(
      `${this.apiUrl}/auth/register`,
      { username, displayName, email, password }
    ));
  }

  async restoreFromBackup(file: File) {
    const formData = new FormData();
    formData.append('backup', file);
    return await firstValueFrom(this.http.post<{ success: boolean }>(`${this.apiUrl}/setup/restore`, formData));
  }


  async getBackupStatus() {
    return await firstValueFrom(this.http.get<{ 
      schedule: string, 
      backupTime: string, 
      lastAutomatedAt: string | null, 
      lastManualAt: string | null, 
      files: any[], 
      absolutePath: string 
    }>(
      `${this.apiUrl}/admin/backup/status`,
      { headers: this.authHeaders() }
    ));
  }


  async saveBackupSchedule(schedule: string, backupTime?: string) {
    return await firstValueFrom(this.http.post<{ success: boolean, schedule: string, backupTime: string }>(
      `${this.apiUrl}/admin/backup/schedule`,
      { schedule, backupTime },
      { headers: this.authHeaders() }
    ));
  }


  async runBackupNow() {
    return await firstValueFrom(this.http.post<{ success: boolean, filename: string }>(
      `${this.apiUrl}/admin/backup/now`,
      {},
      { headers: this.authHeaders() }
    ));
  }

  async deleteBackup(filename: string) {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/admin/backup/${filename}`, { headers: this.authHeaders() }));
  }

  async disableUser2fa(userId: number) {
    return await firstValueFrom(this.http.post<{ success: boolean }>(
      `${this.apiUrl}/admin/users/${userId}/disable-2fa`,
      {},
      { headers: this.authHeaders() }
    ));
  }


  async downloadBackup(filename: string) {
    const blob = await firstValueFrom(this.http.get(`${this.apiUrl}/admin/backup/download/${encodeURIComponent(filename)}`, {
      headers: this.authHeaders(), responseType: 'blob'
    }));
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }


  private applyTheme() {
    const theme = this.effectiveTheme;
    document.body.classList.toggle('light-theme', theme === 'light');
    document.documentElement.style.colorScheme = theme;
  }

  private getStoredSession() {
    const stored = localStorage.getItem(this.sessionKey);
    if (!stored) return null;

    try {
      const session = JSON.parse(stored) as AuthSessionI;
      if (this.usesBrowserSession) {
        this.legacyBrowserToken = session.token || '';
        session.token = '';
        localStorage.setItem(this.sessionKey, JSON.stringify(session));
      }
      return session;
    } catch {
      localStorage.removeItem(this.sessionKey);
      return null;
    }
  }
}
