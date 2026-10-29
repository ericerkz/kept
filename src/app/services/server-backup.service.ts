import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';
import { NativeWorkspaceService } from './native-workspace.service';

const NETWORK_CHUNK = 4 * 1024 * 1024;
const FILE_CHUNK = 256 * 1024;

@Injectable({ providedIn: 'root' })
export class ServerBackupService {
  constructor(private http: HttpClient, private auth: AuthService, private native: NativeWorkspaceService) {}

  async createAndDownload() {
    const backup = await this.auth.createFullBackup();
    await this.download(backup.filename, backup.size);
    return backup;
  }

  async download(filename: string, size: number) {
    const url = `${environment.apiUrl}/admin/backup/download/${encodeURIComponent(filename)}`;
    if (!Capacitor.isNativePlatform()) {
      // Browser sessions already authenticate the download with their HttpOnly
      // cookie. Let the browser stream it to disk instead of building a Blob.
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      return;
    }
    await this.native.ready;
    const plugin = this.native.plugin;
    if (!plugin || !this.native.capabilities$.value?.streamingFiles) throw new Error('Update the native Kept app to save a server backup.');
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid backup file size.');
    const { reference } = await plugin.beginExport({ name: filename, mimeType: filename.endsWith('.zip') ? 'application/zip' : 'application/vnd.sqlite3' });
    try {
      for (let offset = 0; offset < size; offset += NETWORK_CHUNK) {
        const end = Math.min(offset + NETWORK_CHUNK, size) - 1;
        const response = await firstValueFrom(this.http.get(url, { observe: 'response', responseType: 'arraybuffer',
          headers: this.auth.authHeaders().set('Range', `bytes=${offset}-${end}`) }));
        if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${offset}-${end}/${size}` ||
            !response.body || response.body.byteLength !== end - offset + 1) throw new Error('The server or proxy could not provide the backup download completely.');
        const bytes = new Uint8Array(response.body);
        for (let position = 0; position < bytes.length; position += FILE_CHUNK) {
          const chunk = bytes.subarray(position, position + FILE_CHUNK);
          let binary = '';
          for (let index = 0; index < chunk.length; index += 8192) binary += String.fromCharCode(...chunk.subarray(index, index + 8192));
          await plugin.writeExportChunk({ reference, offset: offset + position, base64: btoa(binary) });
        }
      }
      await plugin.finishExport({ reference });
    } catch (error) {
      await plugin.abortExport({ reference }).catch(() => undefined);
      throw error;
    }
  }
}
