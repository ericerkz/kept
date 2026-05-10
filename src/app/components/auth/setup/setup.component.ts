import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';

@Component({
    selector: 'app-setup',
    templateUrl: './setup.component.html',
    styleUrls: ['../auth-shared.scss'],
    standalone: false
})
export class SetupComponent {
  username = '';
  displayName = '';
  displayNameTouched = false;
  password = '';
  confirmPassword = '';
  importTakeoutAfterCreate = false;
  enable2fa = false;
  totpSecret = '';
  qrCodeUrl = '';
  totpToken = '';
  backupCodes: string[] | null = null;
  error = '';
  isSaving = false;
  isGenerating2fa = false;

  // Restore logic
  isRestoringFromBackup = false;
  selectedBackupFile: File | null = null;
  isRestoring = false;


  constructor(private auth: AuthService, private router: Router) { }

  onUsernameChange(value: string) {
    this.username = value;
    if (!this.displayNameTouched) this.displayName = value;
  }

  onDisplayNameInput() {
    this.displayNameTouched = true;
  }

  async toggle2fa(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    this.enable2fa = checked;
    if (checked && !this.qrCodeUrl) {
      this.isGenerating2fa = true;
      try {
        // Pass the typed username so the authenticator app labels the entry
        // with the user's chosen handle. Falls back to "admin" server-side
        // if they haven't typed one yet.
        const usernameForLabel = this.username.trim() || undefined;
        const { secret, qrCodeUrl } = await this.auth.generateSetup2fa(usernameForLabel);
        this.totpSecret = secret;
        this.qrCodeUrl = qrCodeUrl;
      } catch (e: any) {
        this.error = this.getErrorMessage(e, 'Could not generate 2FA secret.');
        this.enable2fa = false;
      } finally {
        this.isGenerating2fa = false;
      }
    }
  }

  async submit() {
    this.error = '';
    if (this.password !== this.confirmPassword) {
      this.error = 'Passwords do not match.';
      return;
    }
    if (this.enable2fa && !this.totpToken) {
      this.error = 'Please enter the 6-digit code from your authenticator app.';
      return;
    }

    this.isSaving = true;
    try {
      const result = await this.auth.createInitialAdmin(this.username, this.displayName, this.password, this.enable2fa ? this.totpSecret : undefined, this.enable2fa ? this.totpToken : undefined);
      if (result.backupCodes) {
        this.backupCodes = result.backupCodes;
        // Reset so the "I have saved my backup codes" button on the next
        // view isn't stuck disabled.
        this.isSaving = false;
        return;
      }
      // Hand off to continueToLogin (it owns isSaving from here on out).
      await this.continueToLogin();
    } catch (error) {
      this.error = this.getErrorMessage(error, 'Could not complete setup.');
      this.isSaving = false;
    }
  }

  onBackupFileSelected(event: any) {
    const file = event.target.files[0];
    if (file && file.name.endsWith('.sqlite')) {
      this.selectedBackupFile = file;
      this.error = '';
    } else {
      this.error = 'Please select a valid .sqlite backup file.';
      this.selectedBackupFile = null;
    }
  }

  async submitRestore() {
    if (!this.selectedBackupFile) return;
    this.isRestoring = true;
    this.error = '';
    try {
      await this.auth.restoreFromBackup(this.selectedBackupFile);
      this.router.navigateByUrl('/login');
    } catch (e: any) {
      this.error = this.getErrorMessage(e, 'Database restoration failed.');
    } finally {
      this.isRestoring = false;
    }
  }


  async continueToLogin() {
    this.isSaving = true;
    try {
      // The TOTP token used during setup is single-use and already consumed
      // server-side, so when 2FA is enabled we can't auto-login — send the
      // user to the login screen to enter a fresh authenticator code.
      if (this.enable2fa) {
        this.router.navigateByUrl('/login');
        return;
      }
      await this.auth.login(this.username, this.password);
      this.router.navigateByUrl(this.importTakeoutAfterCreate ? '/settings' : '/');
    } catch (error) {
      this.error = this.getErrorMessage(error, 'Could not log in after setup.');
    } finally {
      this.isSaving = false;
    }
  }

  private getErrorMessage(error: any, fallback: string) {
    return error?.error?.error || (error instanceof Error ? error.message : fallback);
  }
}
