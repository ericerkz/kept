import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  Kept2OutboxEntry,
  MutationResult,
  SyncCapabilities,
  SyncChanges,
  SyncSnapshot,
  SyncTransport
} from './vault-types';

export class EncryptedSelfHostedTransport implements SyncTransport {
  constructor(
    private readonly http: HttpClient,
    private readonly apiUrl: string,
    private readonly authHeaders: () => HttpHeaders
  ) {}

  capabilities() {
    return firstValueFrom(this.http.get<SyncCapabilities>(`${this.apiUrl}/v2/capabilities`, {
      headers: this.authHeaders()
    }));
  }

  bootstrap(vaultId: string) {
    return firstValueFrom(this.http.get<SyncSnapshot>(`${this.apiUrl}/v2/vaults/${encodeURIComponent(vaultId)}/bootstrap`, {
      headers: this.authHeaders()
    }));
  }

  changes(vaultId: string, cursor: number) {
    return firstValueFrom(this.http.get<SyncChanges>(`${this.apiUrl}/v2/vaults/${encodeURIComponent(vaultId)}/changes`, {
      headers: this.authHeaders(),
      params: { cursor: String(cursor) }
    }));
  }

  mutate(vaultId: string, mutations: Kept2OutboxEntry[]) {
    return firstValueFrom(this.http.post<MutationResult[]>(`${this.apiUrl}/v2/vaults/${encodeURIComponent(vaultId)}/mutations`, {
      mutations
    }, {
      headers: this.authHeaders()
    }));
  }

  uploadBlob(vaultId: string, blobId: string, ciphertext: Blob, ciphertextHash: string) {
    const form = new FormData();
    form.append('blob', ciphertext, blobId);
    form.append('ciphertextHash', ciphertextHash);
    return firstValueFrom(this.http.post<void>(
      `${this.apiUrl}/v2/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      form,
      { headers: this.authHeaders() }
    ));
  }

  downloadBlob(vaultId: string, blobId: string) {
    return firstValueFrom(this.http.get(`${this.apiUrl}/v2/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`, {
      headers: this.authHeaders(),
      responseType: 'blob'
    }));
  }

  subscribeRealtime(_vaultId: string, _onChange: (event: { sequence: number; resourceId: string }) => void) {
    return () => undefined;
  }
}

