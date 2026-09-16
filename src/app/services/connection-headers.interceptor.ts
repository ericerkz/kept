import { Injectable } from '@angular/core';
import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { environment } from 'src/environments/environment';

type NativeConnectionHeader = {
  name: string;
  value: string;
};

type KeptConnectionHeadersPlugin = {
  getEnabledHeaders?: () => Promise<{ headers?: NativeConnectionHeader[] }>;
};

@Injectable()
export class ConnectionHeadersInterceptor implements HttpInterceptor {
  private cachedHeaders: Record<string, string> | null = null;
  private loadingHeaders?: Promise<Record<string, string>>;
  private readonly blockedHeaders = new Set([
    'authorization',
    'cookie',
    'host',
    'content-length',
    'connection',
    'accept-encoding'
  ]);

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const plugin = this.plugin();
    if (!plugin?.getEnabledHeaders || !this.targetsKeptServer(req.url)) return next.handle(req);

    return from(this.loadHeaders(plugin)).pipe(
      switchMap(headers => {
        const setHeaders = this.headersForRequest(headers, req);
        return next.handle(Object.keys(setHeaders).length ? req.clone({ setHeaders }) : req);
      })
    );
  }

  private plugin(): KeptConnectionHeadersPlugin | undefined {
    return (window as any).Capacitor?.Plugins?.KeptConnectionHeaders;
  }

  private targetsKeptServer(url: string) {
    try {
      const base = new URL(environment.apiUrl, window.location.origin);
      const target = new URL(url, base);
      return target.protocol === base.protocol && target.host === base.host;
    } catch {
      return false;
    }
  }

  private loadHeaders(plugin: KeptConnectionHeadersPlugin) {
    if (this.cachedHeaders) return Promise.resolve(this.cachedHeaders);
    if (!this.loadingHeaders) {
      this.loadingHeaders = plugin.getEnabledHeaders!()
        .then(result => {
          const headers = (result?.headers || []).reduce<Record<string, string>>((acc, header) => {
            const name = String(header?.name || '').trim();
            const value = String(header?.value || '');
            if (!name || !value || this.blockedHeaders.has(name.toLowerCase())) return acc;
            acc[name] = value;
            return acc;
          }, {});
          this.cachedHeaders = headers;
          return headers;
        })
        .catch(() => {
          this.cachedHeaders = {};
          return {};
        });
    }
    return this.loadingHeaders;
  }

  private headersForRequest(headers: Record<string, string>, req: HttpRequest<unknown>) {
    return Object.entries(headers).reduce<Record<string, string>>((acc, [name, value]) => {
      if (!req.headers.has(name)) acc[name] = value;
      return acc;
    }, {});
  }
}
