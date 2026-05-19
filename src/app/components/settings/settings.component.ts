import { Component, OnInit } from '@angular/core';
import * as JSZip from 'jszip';
import { ActivatedRoute, Router } from '@angular/router';
import { GoogleCalendarStatusI } from 'src/app/interfaces/reminder';
import { ReminderService } from 'src/app/services/reminder.service';
import { NotesService, TakeoutImportResult } from 'src/app/services/notes.service';

import { AuthService } from 'src/app/services/auth.service';

@Component({
  selector: 'app-settings',
  templateUrl: './settings.component.html',
  styleUrls: ['../auth/auth-shared.scss', './settings.component.scss'],
  standalone: false
})
export class SettingsComponent implements OnInit {

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

  constructor(
    private reminderService: ReminderService,
    private notesService: NotesService,
    private route: ActivatedRoute,
    private router: Router,
    public authService: AuthService
  ) {}

  async ngOnInit() {
    const googleResult = this.route.snapshot.queryParamMap.get('google');
    const googleMessage = this.route.snapshot.queryParamMap.get('message');
    if (googleResult === 'connected') {
      this.success = 'Google Calendar connected successfully.';
      history.replaceState({}, '', '/settings');
    } else if (googleResult === 'error') {
      this.error = googleMessage || 'Google Calendar connection failed.';
      history.replaceState({}, '', '/settings');
    }
    await this.loadAll();
  }

  private async loadAll() {
    this.isLoadingFeed = true;
    this.isLoadingGoogle = true;

    if (this.authService.currentUser) {
      this.totpEnabled = !!this.authService.currentUser.totpEnabled;
      this.hasBackupCodes = !!this.authService.currentUser.hasBackupCodes;
    }

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
      this.takeoutError = e?.error?.error || 'Import failed. Make sure you uploaded a Google Takeout ZIP containing a Keep folder.';
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
