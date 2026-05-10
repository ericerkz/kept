import { Injectable } from '@angular/core';
import { Router, UrlTree } from '@angular/router';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class AuthGuard  {
  constructor(private auth: AuthService, private router: Router) { }

  async canActivate(): Promise<boolean | UrlTree> {
    if (!await this.auth.hasUsers()) return this.router.createUrlTree(['/setup']);
    if (this.auth.currentUser) return true;
    return this.router.createUrlTree(['/login']);
  }
}

@Injectable({
  providedIn: 'root'
})
export class SetupGuard  {
  constructor(private auth: AuthService, private router: Router) { }

  async canActivate(): Promise<boolean | UrlTree> {
    if (!await this.auth.hasUsers()) return true;
    return this.auth.currentUser ? this.router.createUrlTree(['/']) : this.router.createUrlTree(['/login']);
  }
}

@Injectable({
  providedIn: 'root'
})
export class LoginGuard  {
  constructor(private auth: AuthService, private router: Router) { }

  async canActivate(): Promise<boolean | UrlTree> {
    if (!await this.auth.hasUsers()) return this.router.createUrlTree(['/setup']);
    if (this.auth.currentUser) return this.router.createUrlTree(['/']);
    return true;
  }
}

@Injectable({
  providedIn: 'root'
})
export class AdminGuard  {
  constructor(private auth: AuthService, private router: Router) { }

  async canActivate(): Promise<boolean | UrlTree> {
    if (!await this.auth.hasUsers()) return this.router.createUrlTree(['/setup']);
    if (!this.auth.currentUser) return this.router.createUrlTree(['/login']);
    if (this.auth.isAdmin) return true;
    return this.router.createUrlTree(['/']);
  }
}

