import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, Router, UrlTree } from '@angular/router';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class AuthGuard  {
  constructor(private auth: AuthService, private router: Router) { }

  async canActivate(): Promise<boolean | UrlTree> {
    if (this.auth.currentUser) return true;
    try {
      if (!await this.auth.hasUsers()) return this.router.createUrlTree(['/setup']);
    } catch {
      return this.router.createUrlTree(['/login']);
    }
    return this.router.createUrlTree(['/login']);
  }
}

@Injectable({
  providedIn: 'root'
})
export class SetupGuard  {
  constructor(private auth: AuthService, private router: Router) { }

  async canActivate(): Promise<boolean | UrlTree> {
    try {
      if (!await this.auth.hasUsers()) return true;
    } catch {
      return this.auth.currentUser ? this.router.createUrlTree(['/']) : true;
    }
    return this.auth.currentUser ? this.router.createUrlTree(['/']) : this.router.createUrlTree(['/login']);
  }
}

@Injectable({
  providedIn: 'root'
})
export class LoginGuard  {
  constructor(private auth: AuthService, private router: Router) { }

  async canActivate(route: ActivatedRouteSnapshot): Promise<boolean | UrlTree> {
    if (route.queryParamMap.has('oidc_code') || route.queryParamMap.has('oidc_error')) return true;
    if (this.auth.currentUser) {
      const oauthRequest = route.queryParamMap.get('oauth_request');
      if (oauthRequest) {
        window.location.assign(`/oauth/authorize/resume?request=${encodeURIComponent(oauthRequest)}`);
        return false;
      }
      return this.router.createUrlTree(['/']);
    }
    try {
      if (!await this.auth.hasUsers()) return this.router.createUrlTree(['/setup']);
    } catch {
      return true;
    }
    return true;
  }
}

@Injectable({
  providedIn: 'root'
})
export class AdminGuard  {
  constructor(private auth: AuthService, private router: Router) { }

  async canActivate(): Promise<boolean | UrlTree> {
    if (!this.auth.currentUser) return this.router.createUrlTree(['/login']);
    if (this.auth.isAdmin) return true;
    return this.router.createUrlTree(['/']);
  }
}
