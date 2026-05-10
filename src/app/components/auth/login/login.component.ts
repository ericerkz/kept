import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';

@Component({
    selector: 'app-login',
    templateUrl: './login.component.html',
    styleUrls: ['../auth-shared.scss'],
    standalone: false
})
export class LoginComponent implements OnInit {
  username = '';
  password = '';
  totpToken = '';
  error = '';
  isSigningIn = false;
  requires2FA = false;
  registrationEnabled = false;

  constructor(private auth: AuthService, private router: Router) { }

  async ngOnInit() {
    try {
      const settings = await this.auth.getRegistrationSettings();
      this.registrationEnabled = settings.selfRegistrationEnabled;
    } catch {
      this.registrationEnabled = false;
    }
  }

  async submit() {
    this.error = '';
    this.isSigningIn = true;
    try {
      const didLogin = await this.auth.login(this.username, this.password, this.requires2FA ? this.totpToken : undefined);
      if (!didLogin) {
        this.error = 'Username or password is incorrect.';
        return;
      }
      this.router.navigateByUrl('/');
    } catch (e: any) {
      if (e?.requires2FA) {
        this.requires2FA = true;
      } else {
        this.error = e?.error?.error || 'Could not sign in.';
      }
    } finally {
      this.isSigningIn = false;
    }
  }
}
