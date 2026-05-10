import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';

@Component({
    selector: 'app-register',
    templateUrl: './register.component.html',
    styleUrls: ['../auth-shared.scss'],
    standalone: false
})
export class RegisterComponent implements OnInit {
  username = '';
  displayName = '';
  displayNameTouched = false;
  email = '';
  password = '';
  confirmPassword = '';
  error = '';
  successMessage = '';
  isRegistering = false;
  registrationEnabled = false;
  isLoading = true;

  onUsernameChange(value: string) {
    this.username = value;
    if (!this.displayNameTouched) this.displayName = value;
  }

  onDisplayNameInput() {
    this.displayNameTouched = true;
  }

  constructor(private auth: AuthService, private router: Router) { }

  async ngOnInit() {
    try {
      const settings = await this.auth.getRegistrationSettings();
      this.registrationEnabled = settings.selfRegistrationEnabled;
    } catch {
      this.registrationEnabled = false;
    }
    this.isLoading = false;
    if (!this.registrationEnabled) {
      this.router.navigateByUrl('/login');
    }
  }

  async submit() {
    this.error = '';
    this.successMessage = '';

    if (this.password !== this.confirmPassword) {
      this.error = 'Passwords do not match.';
      return;
    }

    this.isRegistering = true;
    try {
      const result = await this.auth.register(this.username, this.displayName, this.email, this.password);
      this.successMessage = result.message;
      this.username = '';
      this.displayName = '';
      this.displayNameTouched = false;
      this.email = '';
      this.password = '';
      this.confirmPassword = '';
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not create account.';
    } finally {
      this.isRegistering = false;
    }
  }
}
