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
  oauthRequest = '';
  private routeSubscription?: Subscription;
  private handledOidcCodes = new Set<string>();

  constructor(private auth: AuthService, private router: Router, private route: ActivatedRoute) { }

  async ngOnInit() {
    this.routeSubscription = this.route.queryParamMap.subscribe(params => {
      this.handleOidcParams(params.get('oidc_code'), params.get('oidc_error'), params.get('oauth_request') || '').catch(console.error);
    });
    const [registration, oidc] = await Promise.allSettled([
      this.auth.getRegistrationSettings(),
      this.auth.getOidcConfig()
    ]);
    if (registration.status === 'fulfilled') this.registrationEnabled = registration.value.selfRegistrationEnabled;
    if (oidc.status === 'fulfilled') {
      this.oidcEnabled = oidc.value.enabled;
      this.oidcName = oidc.value.name;
    }
  }

  ngOnDestroy() {
    this.routeSubscription?.unsubscribe();
  }

  private async handleOidcParams(oidcCode: string | null, oidcError: string | null, oauthRequest: string) {
    this.oauthRequest = oauthRequest;
    if (oidcError) {
      this.error = oidcError === 'no_account'
        ? 'Your identity provider account is not linked to an enabled Kept user.'
        : 'Single sign-on could not be completed. Please try again.';
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
      if (e?.requires2FA) {
        this.requires2FA = true;
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
