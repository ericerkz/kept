import { Component, OnDestroy, OnInit } from '@angular/core';
import * as JSZip from 'jszip';
import { ActivatedRoute, Router } from '@angular/router';
import { GoogleCalendarStatusI } from 'src/app/interfaces/reminder';
import { ReminderService } from 'src/app/services/reminder.service';
import { NotesService, TakeoutImportResult } from 'src/app/services/notes.service';

import { AuthService, McpAccessSettings, OAuthAccessSettings, OidcLinkStatus } from 'src/app/services/auth.service';
import { PushNotificationService } from 'src/app/services/push-notification.service';
import { UserPreferencesService } from 'src/app/services/user-preferences.service';
import {
  androidSmartCaptureEnabled,
  androidMajorVersion,
  isAndroidPlatform,
  isLegacyAndroidSmartCaptureDevice,
  isIosPlatform,
  legacyAndroidSmartCaptureEnabled,
  setAndroidSmartCaptureEnabled,
  setLegacyAndroidSmartCaptureEnabled
} from 'src/app/utils/platform';

export type PermissionStatus = 'granted' | 'denied' | 'notDetermined';

export interface PermissionsStatus {
  reminders: PermissionStatus;
  speechRecognition: PermissionStatus;
  microphone: PermissionStatus;
  location: PermissionStatus;
}

export interface PermissionItem {
  key: keyof PermissionsStatus;
  label: string;
  description: string;
}

@Component({
  selector: 'app-settings',
  templateUrl: './settings.component.html',
  styleUrls: ['../auth/auth-shared.scss', './settings.component.scss'],
  standalone: false
})
export class SettingsComponent implements OnInit, OnDestroy {

  // ── Global feedback ────────────────────────────────────────────────────
  error = '';
  success = '';
  showInstructions: 'google' | 'caldav' | 'takeout' | null = null;

  // ── Phase 0: 2FA ───────────────────────────────────────────────────────
  totpEnabled = false;
  hasBackupCodes = false;
  isGenerating2fa = false;
  isSaving2fa = false;
  isRemoving2fa = false;
  totpSecret = '';
  qrCodeUrl = '';
  totpToken = '';
  backupCodes: string[] | null = null;

  // ── External access ────────────────────────────────────────────────────
  mcpAccess: McpAccessSettings | null = null;
  oauthAccess: OAuthAccessSettings | null = null;
  newMcpAccessToken = '';
  isSavingMcpAccess = false;
  isSavingOAuthAccess = false;
  revokingOAuthConnectionId: number | null = null;
  mcpTokenCopied = false;

  // ── Single sign-on ─────────────────────────────────────────────────────
  oidcLinkStatus: OidcLinkStatus | null = null;
  isStartingOidcLink = false;
  isDisconnectingOidc = false;

  // ── Phase 1: ICS Feed ──────────────────────────────────────────────────
  icsFeedToken = '';
  icsFeedUrl = '';
  icsFeedError = '';
  isLoadingFeed = false;
  isRegeneratingFeed = false;
  feedCopied = false;

  // ── Phase 2: Google Calendar ───────────────────────────────────────────
  googleStatus: GoogleCalendarStatusI | null = null;
  googleClientId = '';
  googleClientSecret = '';
  googleEnabled = true;
  isLoadingGoogle = false;
  isSavingGoogle = false;
  isConnectingGoogle = false;
  readonly googleRedirectUrl = `${window.location.origin}/api/auth/google/callback`;

  // ── Takeout import ─────────────────────────────────────────────────────────
  isImportingTakeout = false;
  takeoutResult: TakeoutImportResult | null = null;
  takeoutError = '';

  // ── Phase 3: CalDAV ────────────────────────────────────────────────────
  calendarUrl = '';
  username = '';
  password = '';
  caldavEnabled = false;
  hasExistingCaldav = false;
  isSavingCaldav = false;
  isTesting = false;
  testResult: { ok: boolean; message: string } | null = null;
  isExporting = false;

  // ── Account deletion ───────────────────────────────────────────────────
  isDeletingAccount = false;
  deleteAccountPassword = '';
  deleteAccountConfirmation = '';
  deleteAccountError = '';

  // ── iOS Permissions ────────────────────────────────────────────────────
  isIos = isIosPlatform();
  isAndroid = isAndroidPlatform();
  androidSmartCaptureEnabled = androidSmartCaptureEnabled();
  legacyAndroidSmartCaptureVisible = isLegacyAndroidSmartCaptureDevice();
  legacyAndroidSmartCaptureEnabled = legacyAndroidSmartCaptureEnabled();
  androidMajorVersion = androidMajorVersion();
  notificationPermissionsVisible = false;
  notificationPermission: NotificationPermission | 'unsupported' = 'unsupported';
  notificationPromptDismissed = false;
  useTwentyFourHourTime = false;
  moveCompletedChecklistItemsToBottom = true;
  richLinkPreviews = true;
  showPastReminders = false;
  notePreviewTextSize: 'compact' | 'default' | 'large' = 'default';
  readonly notePreviewTextSizeOptions: Array<{ value: 'compact' | 'default' | 'large'; label: string }> = [
    { value: 'compact', label: 'Compact' },
    { value: 'default', label: 'Default' },
    { value: 'large', label: 'Large' }
  ];
  permissionsStatus: PermissionsStatus | null = null;
  isLoadingPermissions = false;
  isRequestingPermission: string | null = null;
  permissionsError = '';

  readonly permissions: PermissionItem[] = [
    { key: 'reminders', label: 'Apple Reminders', description: 'needed for reminder sync' },
    { key: 'speechRecognition', label: 'Speech Recognition', description: 'needed for Smart Capture' },
    { key: 'microphone', label: 'Microphone', description: 'needed for Smart Capture' },
    { key: 'location', label: 'Location', description: 'needed for location-based reminders' },
  ];

  private visibilityListener: (() => void) | null = null;

  constructor(
    private reminderService: ReminderService,
    private notesService: NotesService,
    private route: ActivatedRoute,
    private router: Router,
    public authService: AuthService,
    private push: PushNotificationService,
    private preferences: UserPreferencesService
  ) {}

  async ngOnInit() {
    const oidcLinkResult = this.route.snapshot.queryParamMap.get('oidc_link');
    const googleResult = this.route.snapshot.queryParamMap.get('google');
    const googleMessage = this.route.snapshot.queryParamMap.get('message');
    if (googleResult === 'connected') {
      this.success = 'Google Calendar connected successfully.';
      history.replaceState({}, '', '/settings');
    } else if (googleResult === 'error') {
      this.error = googleMessage || 'Google Calendar connection failed.';
      history.replaceState({}, '', '/settings');
    }
    if (oidcLinkResult) {
      const messages: Record<string, string> = {
        connected: 'Single sign-on account connected successfully.',
        already_connected: 'That single sign-on account is already connected to another Kept account.',
        missing_identity: 'The identity provider did not return a usable account identifier.',
        account_unavailable: 'This Kept account is no longer available for linking.'
      };
      if (oidcLinkResult === 'connected') this.success = messages[oidcLinkResult];
      else this.error = messages[oidcLinkResult] || 'Could not connect the single sign-on account.';
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('oidc_link');
      history.replaceState({}, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    }
    await this.loadAll();
    this.refreshNotificationPermissionState();
    this.refreshDisplayPreferences();

    if (this.isIos) {
      await this.loadPermissionsStatus();
      this.visibilityListener = () => {
        if (document.visibilityState === 'visible') {
          this.loadPermissionsStatus();
        }
      };
      document.addEventListener('visibilitychange', this.visibilityListener);
    }
  }

  ngOnDestroy() {
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
    }
  }

  toggleLegacyAndroidSmartCapture(event: Event) {
    const enabled = (event.target as HTMLInputElement).checked;
    this.legacyAndroidSmartCaptureEnabled = enabled;
    setLegacyAndroidSmartCaptureEnabled(enabled);
    window.dispatchEvent(new CustomEvent('kept-legacy-smart-capture-changed', { detail: { enabled } }));
  }

  toggleAndroidSmartCapture(event: Event) {
    const enabled = (event.target as HTMLInputElement).checked;
    this.androidSmartCaptureEnabled = enabled;
    setAndroidSmartCaptureEnabled(enabled);
    window.dispatchEvent(new CustomEvent('kept-smart-capture-changed', { detail: { enabled } }));
  }

  showNotificationPrompt() {
    this.push.restoreNotificationPermissionPrompt();
    this.refreshNotificationPermissionState();
    window.dispatchEvent(new CustomEvent('kept-notification-permission-reprompt'));
    this.success = 'Notification prompt restored.';
  }

  toggleTwentyFourHourTime(event: Event) {
    this.useTwentyFourHourTime = (event.target as HTMLInputElement).checked;
    this.preferences.update({ useTwentyFourHourTime: this.useTwentyFourHourTime });
  }

  toggleMoveCompletedChecklistItems(event: Event) {
    this.moveCompletedChecklistItemsToBottom = (event.target as HTMLInputElement).checked;
    this.preferences.update({ moveCompletedChecklistItemsToBottom: this.moveCompletedChecklistItemsToBottom });
  }

  toggleRichLinkPreviews(event: Event) {
    this.richLinkPreviews = (event.target as HTMLInputElement).checked;
    this.preferences.update({ richLinkPreviews: this.richLinkPreviews });
  }

  async toggleShowPastReminders(event: Event) {
    const enabled = (event.target as HTMLInputElement).checked;
    this.showPastReminders = enabled;
    try {
      await this.preferences.updateShowPastReminders(enabled);
    } catch {
      this.refreshDisplayPreferences();
      this.error = 'Could not save the past reminders preference.';
    }
  }

  setNotePreviewTextSize(size: 'compact' | 'default' | 'large') {
    this.notePreviewTextSize = size;
    this.preferences.update({ notePreviewTextSize: size });
  }

  private refreshNotificationPermissionState() {
    this.notificationPermissionsVisible = this.push.notificationsSupported();
    this.notificationPermission = this.push.notificationPermission();
    this.notificationPromptDismissed = this.push.notificationPermissionPromptDismissed();
  }

  private refreshDisplayPreferences() {
    const value = this.preferences.value;
    this.useTwentyFourHourTime = value.useTwentyFourHourTime;
    this.moveCompletedChecklistItemsToBottom = value.moveCompletedChecklistItemsToBottom;
    this.richLinkPreviews = value.richLinkPreviews;
    this.showPastReminders = value.showPastReminders;
    this.notePreviewTextSize = value.notePreviewTextSize;
  }

  private async loadAll() {
    this.isLoadingFeed = true;
    this.isLoadingGoogle = true;

    if (this.authService.currentUser) {
      this.totpEnabled = !!this.authService.currentUser.totpEnabled;
      this.hasBackupCodes = !!this.authService.currentUser.hasBackupCodes;
    }

    try {
      [this.mcpAccess, this.oauthAccess, this.oidcLinkStatus] = await Promise.all([
        this.authService.getMcpAccessSettings(),
        this.authService.getOAuthAccessSettings(),
        this.authService.getOidcLinkStatus()
      ]);
    } catch {}

    try {
      const feed = await this.reminderService.getIcsFeedToken();
      this.icsFeedToken = feed.token;
      this.icsFeedUrl = `${window.location.origin}/api/reminders/ics/${feed.token}/kept-reminders.ics`;
    } catch (e: any) {
      this.icsFeedError = e?.error?.error || e?.message || 'Could not load feed URL.';
    }
    this.isLoadingFeed = false;

    try {
      this.googleStatus = await this.reminderService.getGoogleCalendarStatus();
      if (this.googleStatus.clientId) this.googleClientId = this.googleStatus.clientId;
      if (this.googleStatus.hasCredentials) this.googleClientSecret = '••••••••';
      this.googleEnabled = this.googleStatus.enabled;
    } catch {}
    this.isLoadingGoogle = false;

    try {
      const caldav = await this.reminderService.getCalDavSettings();
      if (caldav) {
        this.hasExistingCaldav = true;
        this.calendarUrl = caldav.calendarUrl;
        this.username = caldav.username;
        this.password = '••••••••';
        this.caldavEnabled = caldav.enabled;
      }
    } catch {}

  }

  async connectOidc() {
    this.isStartingOidcLink = true;
    this.error = '';
    try {
      const result = await this.authService.startOidcLink();
      window.location.assign(result.url);
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not start the single sign-on connection.';
      this.isStartingOidcLink = false;
    }
  }

  async disconnectOidc() {
    const provider = this.oidcLinkStatus?.providerName || 'single sign-on';
    if (!confirm(`Disconnect ${provider}? You will no longer be able to use it to sign in to this Kept account.`)) return;
    this.isDisconnectingOidc = true;
    this.error = '';
    try {
      await this.authService.disconnectOidcLink();
      if (this.oidcLinkStatus) {
        this.oidcLinkStatus = { ...this.oidcLinkStatus, connected: false, identityEmail: '', connectedAt: null };
      }
      this.success = `${provider} disconnected.`;
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not disconnect the single sign-on account.';
    } finally {
      this.isDisconnectingOidc = false;
    }
  }

  async toggleMcpAccess(event: Event) {
    const enabled = (event.target as HTMLInputElement).checked;
    this.isSavingMcpAccess = true;
    this.error = '';
    try {
      if (enabled) {
        this.mcpAccess = await this.authService.enableMcpAccess();
        this.newMcpAccessToken = this.mcpAccess.accessToken || '';
        this.success = 'Local MCP access enabled. Save the token now.';
      } else {
        await this.authService.disableMcpAccess();
        this.mcpAccess = {
          enabled: false,
          allowLockedNotes: !!this.mcpAccess?.allowLockedNotes,
          allowPermanentDelete: !!this.mcpAccess?.allowPermanentDelete,
          token: null
        };
        this.newMcpAccessToken = '';
        this.success = 'Local MCP access disabled. OAuth app connections were not changed.';
      }
    } catch (e: any) {
      (event.target as HTMLInputElement).checked = !enabled;
      this.error = e?.error?.error || 'Could not update local MCP access.';
    } finally {
      this.isSavingMcpAccess = false;
    }
  }

  async regenerateMcpToken() {
    if (!confirm('Generate a new MCP token? The current token will stop working immediately.')) return;
    this.isSavingMcpAccess = true;
    this.error = '';
    try {
      this.mcpAccess = await this.authService.enableMcpAccess();
      this.newMcpAccessToken = this.mcpAccess.accessToken || '';
      this.success = 'A new MCP token was generated. Save it now.';
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not regenerate the MCP token.';
    } finally {
      this.isSavingMcpAccess = false;
    }
  }

  async toggleOAuthAccess(event: Event) {
    const input = event.target as HTMLInputElement;
    const enabled = input.checked;
    if (!enabled && this.oauthAccess?.connections.length
      && !confirm('Disable OAuth app access? All connected OAuth apps will be signed out. Local MCP access will not be changed.')) {
      input.checked = true;
      return;
    }
    this.isSavingOAuthAccess = true;
    this.error = '';
    try {
      if (enabled) {
        this.oauthAccess = await this.authService.enableOAuthAccess();
        this.success = 'OAuth app access enabled.';
      } else {
        await this.authService.disableOAuthAccess();
        this.oauthAccess = {
          enabled: false,
          allowLockedNotes: !!this.oauthAccess?.allowLockedNotes,
          allowPermanentDelete: !!this.oauthAccess?.allowPermanentDelete,
          connections: []
        };
        this.success = 'OAuth app access disabled. Connected OAuth apps have been signed out.';
      }
    } catch (e: any) {
      input.checked = !enabled;
      this.error = e?.error?.error || 'Could not update OAuth app access.';
    } finally {
      this.isSavingOAuthAccess = false;
    }
  }

  async revokeOAuthConnection(connectionId: number, clientName: string) {
    if (!confirm(`Revoke ${clientName}'s access to Kept?`)) return;
    this.revokingOAuthConnectionId = connectionId;
    this.error = '';
    try {
      await this.authService.revokeOAuthConnection(connectionId);
      if (this.oauthAccess) {
        this.oauthAccess = {
          ...this.oauthAccess,
          connections: this.oauthAccess.connections.filter(connection => connection.id !== connectionId)
        };
      }
      this.success = `${clientName} was disconnected.`;
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not revoke the OAuth connection.';
    } finally {
      this.revokingOAuthConnectionId = null;
    }
  }

  async updateExternalCapability(field: 'allowLockedNotes' | 'allowPermanentDelete', event: Event) {
    if (!this.mcpAccess || !this.oauthAccess) return;
    const enabled = (event.target as HTMLInputElement).checked;
    const previous = this.mcpAccess[field];
    this.mcpAccess = { ...this.mcpAccess, [field]: enabled };
    this.oauthAccess = { ...this.oauthAccess, [field]: enabled };
    try {
      const capabilities = await this.authService.updateExternalAccessCapabilities({ [field]: enabled });
      this.mcpAccess = { ...this.mcpAccess, ...capabilities };
      this.oauthAccess = { ...this.oauthAccess, ...capabilities };
    } catch (e: any) {
      this.mcpAccess = { ...this.mcpAccess, [field]: previous };
      this.oauthAccess = { ...this.oauthAccess, [field]: previous };
      this.error = e?.error?.error || 'Could not update the external access permission.';
    }
  }

  async copyMcpToken() {
    if (!this.newMcpAccessToken) return;
    try {
      await navigator.clipboard.writeText(this.newMcpAccessToken);
      this.mcpTokenCopied = true;
      setTimeout(() => this.mcpTokenCopied = false, 2000);
    } catch {}
  }

  // ── iOS Permissions ──────────────────────────────────────────────────────

  private async loadPermissionsStatus() {
    if (!this.isIos) return;
    this.isLoadingPermissions = true;
    this.permissionsError = '';
    try {
      const plugin = (window as any).Capacitor?.Plugins?.KeptIntelligence;
      if (!plugin) {
        this.permissionsError = 'KeptIntelligence plugin not available.';
        return;
      }
      this.permissionsStatus = await plugin.getPermissionsStatus();
    } catch (e: any) {
      this.permissionsError = e?.message || 'Could not load permission statuses.';
    } finally {
      this.isLoadingPermissions = false;
    }
  }

  async requestPermission(key: string) {
    if (!this.isIos) return;
    this.isRequestingPermission = key;
    this.permissionsError = '';
    try {
      const KeptReminders = (window as any).Capacitor?.Plugins?.KeptReminders;
      const KeptIntelligence = (window as any).Capacitor?.Plugins?.KeptIntelligence;

      switch (key) {
        case 'reminders':
          await KeptReminders?.requestAccess();
          break;
        case 'speechRecognition':
          await KeptIntelligence?.requestSpeechAccess();
          break;
        case 'microphone':
          await KeptIntelligence?.requestMicrophoneAccess();
          break;
        case 'location':
          await KeptReminders?.requestLocationAccess();
          break;
      }
    } catch (e: any) {
      this.permissionsError = e?.message || `Could not request ${key} permission.`;
    } finally {
      this.isRequestingPermission = null;
      // Reload status after request
      await this.loadPermissionsStatus();
    }
  }

  async openAppSettings() {
    if (!this.isIos) return;
    try {
      const plugin = (window as any).Capacitor?.Plugins?.KeptIntelligence;
      await plugin?.openAppSettings();
    } catch (e: any) {
      this.permissionsError = e?.message || 'Could not open app settings.';
    }
  }

  // ── Two-Factor Authentication ────────────────────────────────────────────

  async toggle2fa(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    if (checked) {
      if (!this.qrCodeUrl) {
        await this.generate2fa();
      }
    } else {
      if (this.totpEnabled) {
        if (confirm('Are you sure you want to disable Two-Factor Authentication?')) {
          await this.remove2fa();
        } else {
          // Revert checkbox state visually if they cancelled
          (event.target as HTMLInputElement).checked = true;
        }
      } else {
        // Just cancel the setup process
        this.qrCodeUrl = '';
      }
    }
  }

  async generate2fa() {
    this.isGenerating2fa = true;
    this.error = '';
    try {
      const { secret, qrCodeUrl } = await this.authService.generateSettings2fa();
      this.totpSecret = secret;
      this.qrCodeUrl = qrCodeUrl;
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not generate 2FA secret.';
    } finally {
      this.isGenerating2fa = false;
    }
  }

  async save2fa() {
    if (!this.totpToken) return;
    this.isSaving2fa = true;
    this.error = '';
    this.success = '';
    try {
      const result = await this.authService.enable2fa(this.totpSecret, this.totpToken);
      this.backupCodes = result.backupCodes;
      this.totpEnabled = true;
      this.hasBackupCodes = true;
      
      // Update session locally
      if (this.authService.currentUser) {
        const session = { ...this.authService.currentUser, totpEnabled: true, hasBackupCodes: true };
        localStorage.setItem('gk_session', JSON.stringify(session));
        this.authService.currentUser$.next(session);
      }
    } catch (e: any) {
      this.error = e?.error?.error || 'Invalid 2FA code.';
    } finally {
      this.isSaving2fa = false;
    }
  }

  async remove2fa() {
    this.isRemoving2fa = true;
    this.error = '';
    this.success = '';
    try {
      await this.authService.disable2fa();
      this.totpEnabled = false;
      this.hasBackupCodes = false;
      this.qrCodeUrl = '';
      this.totpToken = '';
      this.totpSecret = '';
      this.backupCodes = null;
      this.success = 'Two-Factor Authentication disabled.';

      // Update session locally
      if (this.authService.currentUser) {
        const session = { ...this.authService.currentUser, totpEnabled: false, hasBackupCodes: false };
        localStorage.setItem('gk_session', JSON.stringify(session));
        this.authService.currentUser$.next(session);
      }
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not disable 2FA.';
    } finally {
      this.isRemoving2fa = false;
    }
  }

  // ── ICS Feed ─────────────────────────────────────────────────────────────

  async copyFeedUrl() {
    try {
      await navigator.clipboard.writeText(this.icsFeedUrl);
      this.feedCopied = true;
      setTimeout(() => this.feedCopied = false, 2000);
    } catch {}
  }

  async regenerateFeedUrl() {
    this.isRegeneratingFeed = true;
    this.icsFeedError = '';
    try {
      const feed = await this.reminderService.regenerateIcsFeedToken();
      this.icsFeedToken = feed.token;
      this.icsFeedUrl = `${window.location.origin}/api/reminders/ics/${feed.token}/kept-reminders.ics`;
    } catch (e: any) {
      this.icsFeedError = e?.error?.error || e?.message || 'Could not regenerate feed URL.';
    }
    this.isRegeneratingFeed = false;
  }

  // ── Google Calendar ──────────────────────────────────────────────────────

  toggleInstructions(provider: 'google' | 'caldav' | 'takeout') {
    this.showInstructions = this.showInstructions === provider ? null : provider;
  }

  async connectGoogle() {
    this.error = '';
    this.isSavingGoogle = true;
    try {
      await this.reminderService.saveGoogleCredentials({
        clientId: this.googleClientId,
        clientSecret: this.googleClientSecret,
        enabled: this.googleEnabled
      });
      this.isConnectingGoogle = true;
      const { url } = await this.reminderService.initiateGoogleAuth();
      window.location.href = url;
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not initiate Google Calendar connection.';
      this.isSavingGoogle = false;
      this.isConnectingGoogle = false;
    }
  }

  async disconnectGoogle() {
    try {
      await this.reminderService.disconnectGoogleCalendar();
      if (this.googleStatus) this.googleStatus = { ...this.googleStatus, connected: false };
      this.success = 'Google Calendar disconnected.';
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not disconnect.';
    }
  }

  async removeGoogleCredentials() {
    try {
      await this.reminderService.removeGoogleCredentials();
      this.googleStatus = null;
      this.googleClientId = '';
      this.googleClientSecret = '';
      this.success = 'Google Calendar credentials removed.';
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not remove credentials.';
    }
  }

  async saveGoogleEnabled() {
    if (!this.googleStatus?.hasCredentials) return;
    try {
      await this.reminderService.saveGoogleCredentials({
        clientId: this.googleClientId,
        clientSecret: this.googleClientSecret,
        enabled: this.googleEnabled
      });
    } catch {}
  }

  // ── Takeout import ────────────────────────────────────────────────────────

  async importTakeout(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.takeoutResult = null;
    this.takeoutError = '';
    this.isImportingTakeout = true;
    try {
      this.takeoutResult = await this.notesService.importGoogleTakeout(file);
      // Force a reload now: long imports can cause the realtime websocket
      // to drop and the notes-changed broadcast to be missed, leaving the
      // UI showing pre-import state until the user manually refreshes.
      try { await this.notesService.load(); } catch {}
    } catch (e: any) {
      if (e?.status === 413) {
        this.takeoutError = e?.error?.error || 'That Takeout ZIP is too large for this server or proxy. Try importing directly over LAN/SSH, or raise your proxy upload limit.';
      } else if (e?.status === 0) {
        this.takeoutError = 'Import upload could not reach Kept. Large Takeout ZIPs may be blocked by Cloudflare, Nginx, or another proxy before Kept can read them. Try importing directly over LAN/SSH.';
      } else {
        this.takeoutError = e?.error?.error || 'Import failed. If this is a large Takeout ZIP, try importing directly over LAN/SSH or raise your proxy upload limit.';
      }
    } finally {
      this.isImportingTakeout = false;
      (event.target as HTMLInputElement).value = '';
    }
  }

  // ── CalDAV ────────────────────────────────────────────────────────────────

  async saveCaldav() {
    this.error = '';
    this.success = '';
    this.testResult = null;
    this.isSavingCaldav = true;
    try {
      await this.reminderService.saveCalDavSettings({
        serverUrl: this.calendarUrl,
        calendarUrl: this.calendarUrl,
        username: this.username,
        password: this.password,
        enabled: this.caldavEnabled
      });
      this.hasExistingCaldav = true;
      this.success = 'CalDAV settings saved.';
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not save settings.';
    }
    this.isSavingCaldav = false;
  }

  async testCaldav() {
    this.testResult = null;
    this.isTesting = true;
    try {
      const result = await this.reminderService.testCalDavConnection({
        calendarUrl: this.calendarUrl,
        username: this.username,
        password: this.password
      });
      this.testResult = {
        ok: result.ok,
        message: result.ok ? `Connected (HTTP ${result.httpStatus}).` : (result.error || 'Could not connect.')
      };
    } catch (e: any) {
      this.testResult = { ok: false, message: e?.error?.error || 'Connection failed.' };
    }
    this.isTesting = false;
  }

  async removeCaldav() {
    try {
      await this.reminderService.deleteCalDavSettings();
      this.hasExistingCaldav = false;
      this.calendarUrl = '';
      this.username = '';
      this.password = '';
      this.caldavEnabled = false;
      this.testResult = null;
      this.success = 'CalDAV sync removed.';
    } catch {}
  }

  // ── Data Export ──────────────────────────────────────────────────────────

  async exportJSON() {
    this.isExporting = true;
    try {
      const notes = await this.notesService.getAll();
      const blob = new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' });
      this.downloadFile(blob, 'kept-notes-export.json');
      this.success = 'JSON export complete.';
    } catch (e: any) {
      this.error = 'Failed to export JSON.';
    } finally {
      this.isExporting = false;
    }
  }

  async exportCSV() {
    this.isExporting = true;
    try {
      const notes = await this.notesService.getAll();
      const headers = ['id', 'title', 'body', 'labels', 'createdAt', 'updatedAt', 'archived', 'trashed'];
      const rows = notes.map(n => [
        n.id,
        `"${(n.noteTitle || '').replace(/"/g, '""')}"`,
        `"${(n.noteBody || '').replace(/"/g, '""')}"`,
        `"${(n.labels || []).map(l => l.name).join(', ')}"`,
        n.createdAt,
        n.updatedAt,
        n.archived,
        n.trashed
      ]);
      const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv' });
      this.downloadFile(blob, 'kept-notes-export.csv');
      this.success = 'CSV export complete.';
    } catch (e: any) {
      this.error = 'Failed to export CSV.';
    } finally {
      this.isExporting = false;
    }
  }

  async exportMarkdown() {
    this.isExporting = true;
    try {
      const notes = await this.notesService.getAll();
      const zip = new JSZip();

      notes.forEach(n => {
        let md = '';
        md += `# ${n.noteTitle || 'Untitled Note'}\n`;
        md += `**Created:** ${n.createdAt} | **Updated:** ${n.updatedAt}\n`;
        if (n.labels?.length) {
          md += `**Labels:** ${n.labels.map(l => `\`${l.name}\``).join(' ')}\n`;
        }
        md += '\n';

        if (n.isCbox && n.checkBoxes?.length) {
          n.checkBoxes.forEach(cb => {
            md += `- [${cb.done ? 'x' : ' '}] ${cb.data}\n`;
          });
        } else if (n.noteBody) {
          md += `${n.noteBody}\n`;
        }

        if (n.images?.length) {
          md += '\n### Images & Drawings\n';
          n.images.forEach((img, idx) => {
            const alt = img.dataUrl.startsWith('data:') ? `Drawing ${idx + 1}` : `Image ${idx + 1}`;
            // Include full data URL for drawings so they are preserved
            md += `![${alt}](${img.dataUrl})\n\n`;
          });
        }

        // Generate safe filename: YYYY-MM-DD - Title.md
        const date = n.createdAt ? n.createdAt.split('T')[0] : 'unknown-date';
        const title = (n.noteTitle || 'Untitled').replace(/[/\\?%*:|"<>]/g, '-').trim();
        const filename = `${date} - ${title}.md`;
        
        // Add to zip
        zip.file(filename, md);
      });

      const blob = await zip.generateAsync({ type: 'blob' });
      this.downloadFile(blob, 'kept-markdown-export.zip');
      this.success = 'Markdown ZIP export complete.';
    } catch (e: any) {
      this.error = 'Failed to export Markdown ZIP.';
      console.error(e);
    } finally {
      this.isExporting = false;
    }
  }

  private downloadFile(blob: Blob, filename: string) {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.URL.revokeObjectURL(url);
  }

  async deleteMyAccount() {
    this.deleteAccountError = '';
    this.error = '';
    this.success = '';
    if (this.deleteAccountConfirmation !== 'DELETE') {
      this.deleteAccountError = 'Type DELETE to confirm.';
      return;
    }
    const finalConfirm = confirm('Permanently delete your account and all notes/data you own? This cannot be undone.');
    if (!finalConfirm) return;

    this.isDeletingAccount = true;
    try {
      await this.authService.deleteOwnAccount(this.deleteAccountPassword, this.deleteAccountConfirmation);
      await this.router.navigateByUrl('/login');
    } catch (e: any) {
      this.deleteAccountError = e?.error?.error || 'Could not delete account.';
    } finally {
      this.isDeletingAccount = false;
    }
  }
}
