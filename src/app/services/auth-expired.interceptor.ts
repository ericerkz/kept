import { Injectable } from '@angular/core';
import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { Observable, catchError, throwError, from, switchMap } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';
import { ManagedHostingService } from './managed-hosting.service';

@Injectable()
export class AuthExpiredInterceptor implements HttpInterceptor {
  constructor(private auth: AuthService, private managedHosting: ManagedHostingService) {}

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const base = new URL(environment.apiUrl, window.location.origin);
    const target = new URL(req.url, window.location.origin);
    const targetsKept = target.origin === base.origin &&
      (target.pathname === base.pathname || target.pathname.startsWith(base.pathname + '/'));
    const send = (request: HttpRequest<unknown>) => next.handle(request).pipe(catchError(error => {
      if (request.headers.has('Authorization') || (targetsKept && !!this.auth.currentUser)) this.auth.notifySessionExpired(error);
      if (targetsKept && this.auth.isCloudSuspendedError(error)) {
        this.managedHosting.info().then(info => this.auth.notifyCloudSuspended(error, info.providerName));
      }
      return throwError(() => error);
    }));
    if (targetsKept && this.auth.isLocal) return throwError(() => new Error('This operation requires a server connection.'));
    if (!targetsKept || !this.auth.usesBrowserSession) return send(req);
    req = req.clone({ withCredentials: true });
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return send(req);
    return from(this.auth.ensureBrowserCsrf()).pipe(switchMap(csrf =>
      send(req.clone({ setHeaders: { 'X-CSRF-Token': csrf } }))
    ));
  }
}
