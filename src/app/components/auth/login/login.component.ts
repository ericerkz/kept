import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from 'src/app/services/auth.service';

@Component({
    selector: 'app-login',
    templateUrl: './login.component.html',
    styleUrls: ['../auth-shared.scss'],
    standalone: false
})
export class LoginComponent implements OnInit, OnDestroy {
  username = '';
  password = '';
  totpToken = '';
  error = '';
  isSigningIn = false;
  requires2FA = false;
  registrationEnabled = false;
  oidcEnabled = false;
  oidcName = 'Single sign-on';
  passwordLoginEnabled = true;
  loadingSignInOptions = true;
  signInOptionsUnavailable = false;
  oauthRequest = '';
  private routeSubscription?: Subscription;
  private handledOidcCodes = new Set<string>();

  constructor(private auth: AuthService, private router: Router, private route: ActivatedRoute) { }

  async ngOnInit() {
    this.routeSubscription = this.route.queryParamMap.subscribe(params => {
      this.handleOidcParams(params.get('oidc_code'), params.get('oidc_error'), params.get('oauth_request') || '').catch(console.error);
    });
    void this.auth.getRegistrationSettings().then(settings => {
      this.registrationEnabled = settings.selfRegistrationEnabled;
    }).catch(() => {});
    await this.loadSignInOptions();
  }

  async loadSignInOptions() {
    this.loadingSignInOptions = true;
    this.signInOptionsUnavailable = false;
    try {
      const oidc = await this.auth.getOidcConfig();
      this.oidcEnabled = oidc.enabled;
      this.oidcName = oidc.name;
      // Older servers do not expose a password-login policy.
      this.passwordLoginEnabled = oidc.passwordLoginEnabled !== false;
      if (!this.passwordLoginEnabled) {
        this.password = this.totpToken = '';
        this.requires2FA = false;
      }
    } catch {
      this.signInOptionsUnavailable = true;
    } finally {
      this.loadingSignInOptions = false;
    }
  }

  ngOnDestroy() {
    this.routeSubscription?.unsubscribe();
  }

  private async handleOidcParams(oidcCode: string | null, oidcError: string | null, oauthRequest: string) {
    this.oauthRequest = oauthRequest;
    if (oidcError) {
      const messages: Record<string, string> = {
        no_account: 'Your identity provider account is not linked to an enabled Kept user.',
        pending_approval: 'Your account was created. An administrator must approve it before you can sign in.',
        account_unavailable: 'Your account is awaiting approval or has been disabled. Please contact your administrator.'
      };
      this.error = messages[oidcError] || 'Single sign-on could not be completed. Please try again.';
      return;
    }
    if (!oidcCode || this.handledOidcCodes.has(oidcCode)) return;
    this.handledOidcCodes.add(oidcCode);
    this.isSigningIn = true;
    this.error = '';
    try {
      await this.auth.exchangeOidcCode(oidcCode);
      this.finishLogin();
    } catch (e: any) {
      this.error = e?.error?.error || 'Single sign-on could not be completed.';
    } finally {
      this.isSigningIn = false;
    }
  }

  async submit() {
    if (!this.passwordLoginEnabled || this.signInOptionsUnavailable) return;
    this.error = '';
    this.isSigningIn = true;
    try {
      const didLogin = await this.auth.login(this.username, this.password, this.requires2FA ? this.totpToken : undefined);
      if (!didLogin) {
        this.error = 'Username or password is incorrect.';
        return;
      }
      this.finishLogin();
    } catch (e: any) {
      if (e?.error?.code === 'PASSWORD_LOGIN_DISABLED') {
        this.passwordLoginEnabled = false;
        this.requires2FA = false;
        this.password = this.totpToken = '';
        this.error = e.error.error;
      } else if (e?.requires2FA) {
        this.requires2FA = true;
      } else if (e?.status === 0) {
        this.error = 'Could not connect to your server. Check your connection, server address and server configuration.';
      } else if (e?.name === 'TimeoutError' || e?.status === 408) {
        this.error = 'The sign-in request timed out. Please try again.';
      } else if (e?.status === 429) {
        this.error = e?.error?.error || 'Too many sign-in attempts. Please try again later.';
      } else if (e?.status >= 500) {
        this.error = 'Your server is temporarily unavailable. Please try again later.';
      } else {
        this.error = e?.error?.error || 'Could not sign in.';
      }
    } finally {
      this.isSigningIn = false;
    }
  }

  signInWithOidc() {
    this.auth.startOidcLogin(this.oauthRequest);
  }

  private finishLogin() {
    if (this.oauthRequest) {
      window.location.assign(`/oauth/authorize/resume?request=${encodeURIComponent(this.oauthRequest)}`);
      return;
    }
    this.router.navigateByUrl('/');
  }
}
