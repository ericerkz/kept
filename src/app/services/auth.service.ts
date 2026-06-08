import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, BehaviorSubject } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthSessionI, UserI, UserRole, UserTheme } from '../interfaces/users';

type LoginResponse = {
  token: string
  user: UserI
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly sessionKey = 'gk_session';
  private readonly apiUrl = environment.apiUrl;
  currentUser$ = new BehaviorSubject<AuthSessionI | null>(this.getStoredSession());

  constructor(private http: HttpClient) {
    this.applyTheme(this.currentUser?.theme || 'light');
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
    return new HttpHeaders({ Authorization: `Bearer ${this.token}` });
  }

  canonicalImageUrl(value: string) {
    const raw = String(value || '').trim();
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
    const token = this.token;
    const imageUrl = this.apiUrl.startsWith('http') ? `${this.apiUrl}${canonical.slice('/api'.length)}` : canonical;
    if (!token) return imageUrl;
    return `${imageUrl}?token=${encodeURIComponent(token)}`;
  }

  authenticatedImageHtml(html: string) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    div.querySelectorAll<HTMLImageElement>('img[src]').forEach(img => {
      img.setAttribute('src', this.authenticatedImageUrl(img.getAttribute('src') || img.src));
    });
    return div.innerHTML;
  }

  canonicalImageHtml(html: string) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
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
    this.applyTheme('light');
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
      result = await firstValueFrom(this.http.post<LoginResponse>(`${this.apiUrl}/auth/login`, payload));
    } catch (error: any) {
      if (error?.error?.requires2FA) {
        throw { requires2FA: true };
      }
      if (error?.status === 403) {
        throw error;
      }
      return false;
    }

    const session: AuthSessionI = {
      token: result.token,
      id: result.user.id!,
      username: result.user.username,
      displayName: result.user.displayName,
      role: result.user.role,
      theme: result.user.theme || 'light',
      avatarDataUrl: result.user.avatarDataUrl || '',
      avatarPreset: result.user.avatarPreset || 'cat',
      totpEnabled: result.user.totpEnabled,
      hasBackupCodes: result.user.hasBackupCodes,
      demoNotesCreatedAt: result.user.demoNotesCreatedAt ?? null
    };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.currentUser$.next(session);
    this.applyTheme(session.theme);
    return true;
  }

  async updateTheme(theme: UserTheme) {
    const user = await firstValueFrom(this.http.patch<UserI>(
      `${this.apiUrl}/users/me/preferences`,
      { theme },
      { headers: this.authHeaders() }
    ));
    const current = this.currentUser;
    if (!current) return;

    const session = { ...current, theme: user.theme || theme };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.currentUser$.next(session);
    this.applyTheme(session.theme);
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
    if (this.token) {
      try {
        await firstValueFrom(this.http.post(`${this.apiUrl}/auth/logout`, {}, { headers: this.authHeaders() }));
      } catch {
        // Local logout should still succeed if the API is temporarily unavailable.
      }
    }
    localStorage.removeItem(this.sessionKey);
    this.currentUser$.next(null);
    this.applyTheme('light');
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


  getBackupDownloadUrl(filename: string) {
    return `${this.apiUrl}/admin/backup/download/${filename}?token=${this.token}`;
  }


  private applyTheme(theme: UserTheme) {
    document.body.classList.toggle('light-theme', theme === 'light');
  }

  private getStoredSession() {
    const stored = localStorage.getItem(this.sessionKey);
    if (!stored) return null;

    try {
      return JSON.parse(stored) as AuthSessionI;
    } catch {
      localStorage.removeItem(this.sessionKey);
      return null;
    }
  }
}
