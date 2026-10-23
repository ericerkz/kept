import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';

export interface ManagedHostingInfo {
  managed: boolean;
  providerName: string;
  accountUrl: string;
  externalBackups: boolean;
  quotaBytes: number | null;
}

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number | null;
  remainingBytes: number | null;
  percentUsed: number | null;
}

const UNMANAGED: ManagedHostingInfo = {
  managed: false,
  providerName: '',
  accountUrl: '',
  externalBackups: false,
  quotaBytes: null
};

// Generic managed-hosting metadata (KEPT_MANAGED_* env vars). Any
// provider can set these; this service holds no provider-specific
// business logic, just the client side of the public primitive.
@Injectable({ providedIn: 'root' })
export class ManagedHostingService {
  private readonly apiUrl = environment.apiUrl;
  private infoPromise: Promise<ManagedHostingInfo> | null = null;

  constructor(private http: HttpClient, private auth: AuthService) {}

  info(): Promise<ManagedHostingInfo> {
    if (this.auth.isLocal) return Promise.resolve(UNMANAGED);
    if (!this.infoPromise) {
      this.infoPromise = firstValueFrom(this.http.get<ManagedHostingInfo>(`${this.apiUrl}/settings/managed-hosting`))
        .catch(() => UNMANAGED);
    }
    return this.infoPromise;
  }

  async storageUsage(): Promise<StorageUsage | null> {
    if (this.auth.isLocal || !this.auth.currentUser) return null;
    try {
      return await firstValueFrom(this.http.get<StorageUsage>(`${this.apiUrl}/settings/storage`, { headers: this.auth.authHeaders() }));
    } catch {
      return null;
    }
  }
}
