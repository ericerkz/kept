import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  Kept2OutboxEntry,
  MutationResult,
  SyncCapabilities,
  SyncChanges,
  SyncSnapshot,
  SyncTransport,
  VaultDevicePublicKey
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

  registerDevice(vaultId: string, deviceId: string, publicKey: string, deviceLabel = '') {
    return firstValueFrom(this.http.put<VaultDevicePublicKey>(
      `${this.apiUrl}/v2/vaults/${encodeURIComponent(vaultId)}/devices/${encodeURIComponent(deviceId)}`,
      { publicKey, deviceLabel },
      { headers: this.authHeaders() }
    ));
  }

  async listDevices(vaultId: string) {
    const response = await firstValueFrom(this.http.get<{ devices: VaultDevicePublicKey[] }>(
      `${this.apiUrl}/v2/vaults/${encodeURIComponent(vaultId)}/devices`,
      { headers: this.authHeaders() }
    ));
    return response.devices || [];
  }

  async revokeDevice(vaultId: string, deviceId: string) {
    await firstValueFrom(this.http.delete(
      `${this.apiUrl}/v2/vaults/${encodeURIComponent(vaultId)}/devices/${encodeURIComponent(deviceId)}`,
      { headers: this.authHeaders() }
    ));
  }

  subscribeRealtime(vaultId: string, onChange: (event: { sequence: number; resourceId: string; vaultId?: string }) => void) {
    const token = this.authToken();
    if (!token || typeof WebSocket === 'undefined') return () => undefined;
    const socket = new WebSocket(this.realtimeUrl(token));
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data || '{}'));
        if (message?.type === 'kept2-resource-changed' && message.vaultId === vaultId) {
          onChange({
            sequence: Number(message.sequence || 0),
            resourceId: String(message.resourceId || ''),
            vaultId: message.vaultId
          });
        }
      } catch {}
    };
    return () => {
      try { socket.close(); } catch {}
    };
  }

  private authToken() {
    const header = this.authHeaders().get('Authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  }

  private realtimeUrl(token: string) {
    const encodedToken = encodeURIComponent(token);
    if (this.apiUrl.startsWith('http')) {
      return `${this.apiUrl.replace(/^http/, 'ws')}/realtime?token=${encodedToken}`;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${this.apiUrl}/realtime?token=${encodedToken}`;
  }
}
