import { Injectable } from '@angular/core';
import { HttpErrorResponse, HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { Observable, catchError, throwError, from, switchMap } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';

@Injectable()
export class AuthExpiredInterceptor implements HttpInterceptor {
  constructor(private auth: AuthService) {}

  private async handleSuspension(error: HttpErrorResponse) {
    try {
      // File downloads use Blob responses, and some endpoints request text.
      // Normalize the gateway's JSON without changing the error callers receive.
      const body = error.error instanceof Blob ? await error.error.text() : error.error;
      const payload = typeof body === 'string' ? JSON.parse(body) : body;
      this.auth.notifyCloudSuspended(new HttpErrorResponse({
        error: payload, headers: error.headers, status: error.status, statusText: error.statusText, url: error.url || undefined
      }));
    } catch { /* A non-JSON 402 is not the suspension contract. */ }
  }

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const base = new URL(environment.apiUrl, window.location.origin);
    const target = new URL(req.url, window.location.origin);
    const targetsKept = target.origin === base.origin &&
      (target.pathname === base.pathname || target.pathname.startsWith(base.pathname + '/'));
    const send = (request: HttpRequest<unknown>) => next.handle(request).pipe(catchError(error => {
      if (request.headers.has('Authorization') || (targetsKept && !!this.auth.currentUser)) this.auth.notifySessionExpired(error);
      if (targetsKept && error.status === 402) void this.handleSuspension(error);
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
