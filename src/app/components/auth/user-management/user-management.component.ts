import { Component, OnInit, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { UserI, UserRole } from 'src/app/interfaces/users';
import { AuthService } from 'src/app/services/auth.service';
import { environment } from 'src/environments/environment';
import { TimepickerUI, type ConfirmEventData } from 'timepicker-ui';


@Component({
    selector: 'app-user-management',
    templateUrl: './user-management.component.html',
    styleUrls: ['../auth-shared.scss', './user-management.component.scss'],
    standalone: false
})
export class UserManagementComponent implements OnInit {
  users: UserI[] = [];
  username = '';
  displayName = '';
  displayNameTouched = false;
  password = '';
  email = '';
  role: UserRole = 'user';
  error = '';
  success = '';
  isSaving = false;

  // Registration settings
  selfRegistrationEnabled = false;
  requireApproval = true;
  isSavingRegistration = false;

  // Per-user password reset state
  resetPasswordUserId: number | null = null;
  resetPasswordValue = '';
  resetPasswordError = '';
  resetPasswordSuccess = '';
  isResettingPassword = false;
  
  // Backup management
  backupSchedule = 'none';
  backupTime = '03:00';
  absolutePath = '';
  lastAutomatedAt: string | null = null;
  lastManualAt: string | null = null;
  backupFiles: any[] = [] as any[];
  isBackingUp = false;
  
  automatedBackupError = '';
  automatedBackupSuccess = '';
  manualBackupError = '';
  manualBackupSuccess = '';

  confirmDeleteUserId: number | null = null;




  private backupTimePicker?: TimepickerUI;



  // Version / update info shown in the About section
  versionInfo: { current: string; latest: string | null; isOutdated: boolean; releaseUrl: string | null; checkedAt: string | null; checkError: string | null } | null = null;

  constructor(public auth: AuthService, private zone: NgZone, private http: HttpClient) { }

  async loadVersionInfo() {
    try {
      const data: any = await firstValueFrom(
        this.http.get(`${environment.apiUrl}/admin/update-status`, { headers: this.auth.authHeaders() })
      );
      this.versionInfo = {
        current: data.current,
        latest: data.latest,
        isOutdated: !!data.isOutdated,
        releaseUrl: data.releaseUrl,
        checkedAt: data.checkedAt,
        checkError: data.checkError
      };
    } catch {
      this.versionInfo = null;
    }
  }

  onUsernameChange(value: string) {
    this.username = value;
    if (!this.displayNameTouched) this.displayName = value;
  }

  onDisplayNameInput() {
    this.displayNameTouched = true;
  }

  async loadUsers() {
    this.users = await this.auth.listUsers();
  }

  async loadRegistrationSettings() {
    try {
      const settings = await this.auth.getRegistrationSettings();
      this.selfRegistrationEnabled = settings.selfRegistrationEnabled;
      this.requireApproval = settings.requireApproval;
    } catch {}
  }

  async createUser() {
    this.error = '';
    this.success = '';
    this.isSaving = true;
    try {
      await this.auth.createManagedUser(this.username, this.displayName, this.password, this.role, this.email || undefined);
      this.username = '';
      this.displayName = '';
      this.displayNameTouched = false;
      this.password = '';
      this.email = '';
      this.role = 'user';
      this.success = 'User created.';
      await this.loadUsers();
    } catch (error) {
      this.error = this.getErrorMessage(error, 'Could not create user.');
    } finally {
      this.isSaving = false;
    }
  }

  async confirmDeleteUser(user: UserI) {
    this.confirmDeleteUserId = user.id || null;
  }

  async cancelDeleteUser() {
    this.confirmDeleteUserId = null;
  }

  async deleteUser(user: UserI) {
    this.error = '';
    this.success = '';
    this.confirmDeleteUserId = null;
    try {
      await this.auth.deleteUser(user);
      this.success = `User ${user.username} deleted.`;
      await this.loadUsers();
    } catch (error) {
      this.error = this.getErrorMessage(error, 'Could not delete user.');
    }
  }


  async toggleUserEnabled(user: UserI) {
    this.error = '';
    this.success = '';
    try {
      const updated = await this.auth.adminToggleUserEnabled(user.id!, !user.enabled);
      this.success = updated.enabled ? `${user.displayName} has been approved.` : `${user.displayName} has been disabled.`;
      await this.loadUsers();
    } catch (error) {
      this.error = this.getErrorMessage(error, 'Could not update user status.');
    }
  }

  openResetPassword(userId: number) {
    this.resetPasswordUserId = this.resetPasswordUserId === userId ? null : userId;
    this.resetPasswordValue = '';
    this.resetPasswordError = '';
    this.resetPasswordSuccess = '';
  }

  async submitResetPassword(userId: number) {
    this.resetPasswordError = '';
    this.resetPasswordSuccess = '';
    if (this.resetPasswordValue.length < 8) {
      this.resetPasswordError = 'Password must be at least 8 characters.';
      return;
    }
    this.isResettingPassword = true;
    try {
      await this.auth.adminResetPassword(userId, this.resetPasswordValue);
      this.resetPasswordSuccess = 'Password has been reset.';
      this.resetPasswordValue = '';
    } catch (error) {
      this.resetPasswordError = this.getErrorMessage(error, 'Could not reset password.');
    } finally {
      this.isResettingPassword = false;
    }
  }

  async saveRegistrationSettings() {
    this.isSavingRegistration = true;
    try {
      const result = await this.auth.saveRegistrationSettings({
        selfRegistrationEnabled: this.selfRegistrationEnabled,
        requireApproval: this.requireApproval
      });
      this.selfRegistrationEnabled = result.selfRegistrationEnabled;
      this.requireApproval = result.requireApproval;
    } catch {}
    this.isSavingRegistration = false;
  }

  async loadBackupStatus() {
    try {
      const status = await this.auth.getBackupStatus();
      this.backupSchedule = status.schedule;
      this.backupTime = status.backupTime;
      this.absolutePath = status.absolutePath;
      this.lastAutomatedAt = status.lastAutomatedAt;
      this.lastManualAt = status.lastManualAt;
      this.backupFiles = status.files;
    } catch {}
  }


  async changeBackupSchedule(schedule: string) {
    this.automatedBackupError = '';
    this.automatedBackupSuccess = '';
    try {
      await this.auth.saveBackupSchedule(schedule, this.backupTime);
      this.backupSchedule = schedule;
      this.automatedBackupSuccess = `Backup schedule updated to ${schedule}.`;
      // The time-picker input is rendered conditionally on schedule !== 'none'.
      // Re-init after the *ngIf reveals it, otherwise the picker never binds.
      if (schedule !== 'none') {
        setTimeout(() => this.initBackupTimePicker(), 0);
      }
    } catch (error) {
      this.automatedBackupError = this.getErrorMessage(error, 'Could not update backup schedule.');
    }
  }



  initBackupTimePicker() {
    const timeInput = document.getElementById('backupTimeInput') as HTMLElement;
    if (!timeInput) return;
    // If we already have a picker bound, dispose so we don't stack listeners
    // when the input element is re-created (e.g. user toggles schedule none
    // -> daily -> none -> daily). The library doesn't expose a clean
    // teardown, so just drop our reference and rebind.
    this.backupTimePicker = undefined;

    this.backupTimePicker = new TimepickerUI(timeInput, {
      clock: {
        currentTime: { time: new Date(), updateInput: false }
      },
      ui: {
        theme: document.body.classList.contains('light-theme') ? 'basic' : 'dark',
        editable: true
      },
      callbacks: {
        onConfirm: (data: ConfirmEventData) => {
          this.zone.run(async () => {
            const hour = String(data.hour || '').padStart(2, '0');
            const min = String(data.minutes || '').padStart(2, '0');
            const ampm = data.type;
            
            let h = parseInt(hour);
            if (ampm === 'PM' && h < 12) h += 12;
            if (ampm === 'AM' && h === 12) h = 0;
            
            const newTime = `${String(h).padStart(2, '0')}:${min}`;
            this.backupTime = newTime;
            
            try {
              await this.auth.saveBackupSchedule(this.backupSchedule, this.backupTime);
              this.automatedBackupSuccess = `Backup time updated to ${data.hour}:${data.minutes} ${data.type}.`;
            } catch (error) {
              this.automatedBackupError = this.getErrorMessage(error, 'Could not update backup time.');
            }


          });
        }
      }
    });
    this.backupTimePicker.create();

  }

  openBackupTimePicker() {
    // Lazy-init if the picker hasn't been bound yet (covers the case where
    // the schedule was 'none' on page load, so the input wasn't in the DOM
    // when ngOnInit ran).
    if (!this.backupTimePicker) {
      this.initBackupTimePicker();
    }
    this.backupTimePicker?.open();
  }



  async runBackupNow() {
    this.isBackingUp = true;
    this.manualBackupError = '';
    this.manualBackupSuccess = '';
    try {
      const result = await this.auth.runBackupNow();
      this.manualBackupSuccess = `Manual backup successful: ${result.filename}`;
      await this.loadBackupStatus();
    } catch (error) {
      this.manualBackupError = this.getErrorMessage(error, 'Manual backup failed.');
    } finally {
      this.isBackingUp = false;
    }
  }




  async deleteBackup(filename: string) {
    if (!confirm('Are you sure you want to delete this backup?')) return;
    try {
      await this.auth.deleteBackup(filename);
      await this.loadBackupStatus();
    } catch {}
  }

  downloadBackup(filename: string) {
    window.open(this.auth.getBackupDownloadUrl(filename), '_blank');
  }

  formatSize(bytes: number) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }


  ngOnInit(): void {
    this.loadUsers();
    this.loadRegistrationSettings();
    this.loadVersionInfo();
    this.loadBackupStatus().then(() => {
      setTimeout(() => this.initBackupTimePicker(), 500);
    });
  }

  async disableUser2fa(userId: number) {
    if (!confirm('Are you sure you want to disable 2FA for this user? They will be able to log in with just their password.')) return;
    
    this.error = '';
    this.success = '';
    try {
      await this.auth.disableUser2fa(userId);
      this.success = '2FA has been disabled for the user.';
      await this.loadUsers();
    } catch (error) {
      this.error = this.getErrorMessage(error, 'Could not disable 2FA.');
    }
  }

  private getErrorMessage(error: any, fallback: string) {
    return error?.error?.error || (error instanceof Error ? error.message : fallback);
  }

}
