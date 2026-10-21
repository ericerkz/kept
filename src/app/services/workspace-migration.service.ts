import { attachmentMimeType } from '../utils/attachments';
import { Injectable } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { BehaviorSubject } from 'rxjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { RESOURCE_STORES, ResourceType, Workspace } from '../interfaces/workspace';
import { NativeWorkspaceService } from './native-workspace.service';
import { OfflineStoreService } from './offline-store.service';
import { WorkspaceService } from './workspace.service';
import { canonicalJson } from '../../../shared/canonical-json';

type Connection = {connectionId: string; url: string; accountId: number; token: string; headers?: Record<string,string>};
@Injectable({providedIn: 'root'})
export class WorkspaceMigrationService {
  readonly progress$ = new BehaviorSubject('');
  private busy = false;
  constructor(private native: NativeWorkspaceService, private store: OfflineStoreService, private workspaces: WorkspaceService) {}

  private async request(connection: Connection, path: string, method = 'GET', data?: unknown): Promise<any> {
    const base = connection.url.replace(/\/$/, '').replace(/\/api$/, '');
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Choose a valid Kept server URL.');
    const headers = {...connection.headers,Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json'};
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.request({url: `${base}/api/workspace-import${path}`,method,headers,data,connectTimeout:12000,readTimeout:60000});
      if (response.status < 200 || response.status >= 300) throw new Error(response.data?.error || `Transfer request failed (${response.status}).`);
      return response.data;
    }
    const response = await fetch(`${base}/api/workspace-import${path}`, {method,headers,body:data === undefined ? undefined : JSON.stringify(data)});
    if (!response.ok) throw new Error((await response.json()).error || 'Transfer failed.');
    return response.status === 204 ? null : response.json();
  }

  async moveToServer(copyPreferences = false) {
    if (this.busy) throw new Error('A transfer is already running.');
    const source = this.workspaces.local;
    if (!source) throw new Error('Open the device workspace you want to move.');
    await this.native.ready;
    if (!this.native.plugin || !this.native.capabilities$.value?.durableActions) throw new Error('Update the native Kept app before moving notes to a server.');
    if (!window.confirm('Sign in to your Kept server and move these notes? A copy will stay on this device until you explicitly remove it.')) return false;
    this.busy = true;
    let snapshot: Workspace | undefined;
    let complete = false;
    let finalizeStarted = source.migration?.state === 'verifying';
    try {
      const connection = await this.native.plugin.prepareServerConnection();
      const capability = await this.request(connection,'/capabilities');
      if (capability.version !== 1 || capability.syncProtocol !== 2) throw new Error('Update your Kept server before moving device notes.');
      if (capability.recordChecksum !== 'canonical-json-v1') throw new Error('Update your Kept server before moving device notes. This server needs the migration checksum fix.');
      const job = await this.request(connection,'','POST',{sourceId:source.id,generation:source.generation});
      await this.store.patchWorkspace(source.id,{migration:{importId:job.id,server:connection.url,state:'uploading'}});
      if (job.state !== 'complete') {
        // First pass permits edits. The final pass drains native actions, freezes
        // the source generation, and uploads a consistent final snapshot.
        snapshot = await this.store.captureBackup(source);
        await this.uploadSnapshot(connection,job.id,snapshot);
        await this.store.discardStaging(snapshot.id); snapshot = undefined;
        await this.native.flush();
        await this.store.patchWorkspace(source.id,{status:'frozen'});
        await this.workspaces.refresh();
        snapshot = await this.store.captureBackup(source);
        const manifest = await this.uploadSnapshot(connection,job.id,snapshot);
        this.progress$.next('Verifying the transfer…');
        await this.store.patchWorkspace(source.id,{migration:{importId:job.id,server:connection.url,state:'verifying'}});
        finalizeStarted = true;
        const result = await this.request(connection,`/${job.id}/finalize`,'POST',{items:manifest,copyPreferences});
        if (!result.verified || result.sourceId !== source.id || result.generation !== source.generation) throw new Error('The server did not verify this workspace.');
      }
      // Retry-safe after a lost finalize response or an interrupted native switch.
      const verified = await this.request(connection,`/${job.id}`);
      if (verified.state !== 'complete' || !verified.result?.verified) throw new Error('The transfer is not complete.');
      await this.native.plugin.cancelReminders({workspaceId:source.id,generation:source.generation});
      await this.store.patchWorkspace(source.id,{status:'retained',migration:{importId:job.id,server:connection.url,state:'complete'}});
      // Native must atomically persist the target server/session while preserving
      // the IndexedDB origin, then reload into connected mode. The old generation
      // stays retained so late extension actions cannot mutate the imported copy.
      await this.workspaces.refresh();
      await this.native.plugin.activateServer({connectionId:connection.connectionId,sourceWorkspaceId:source.id,sourceGeneration:source.generation});
      await this.workspaces.selectServer();
      complete = true;
      window.location.reload();
      return true;
    } finally {
      if (snapshot) await this.store.discardStaging(snapshot.id);
      if (!complete) {
        const current = await this.store.getWorkspace(source.id);
        if (current?.status === 'frozen' && !finalizeStarted) await this.store.patchWorkspace(source.id,{status:'active'});
        await this.workspaces.refresh();
      }
      this.busy = false; this.progress$.next('');
    }
  }

  private async uploadSnapshot(connection: Connection, jobId: string, snapshot: Workspace) {
    const status = await this.request(connection,`/${jobId}`);
    if (status.state === 'complete') return [];
    const saved = new Map<string, any>(status.items.map((item: any)=>[item.key,item]));
    const attachments = new Map<string,any>();
    const manifest: Array<{key: string; digest: string}> = [];
    let after: string | undefined;
    while (true) {
      const [row] = await this.store.snapshotPage(snapshot.id,after);
      if (!row) break;
      after=row.key;
      const kind = row.store === 'blobs' ? 'blob' : 'record';
      let key: string; let payload: any; let digest: string;
      if (kind === 'record') {
        const type = (Object.keys(RESOURCE_STORES) as ResourceType[]).find(type=>RESOURCE_STORES[type] === row.store)!;
        key = `record:${type}:${row.record.syncId}`;
        payload = {type,value:row.record.value};
        if (type === 'attachment') attachments.set(row.record.syncId,row.record.value);
        digest = bytesToHex(sha256(new TextEncoder().encode(canonicalJson(payload))));
      } else {
        const blob: Blob = row.record.value;
        key=`blob:${row.record.blobKey}`;
        const attachment=row.record.blobKey.startsWith('attachment:') ? attachments.get(row.record.blobKey.slice(11)) : undefined;
        payload={blobKey:row.record.blobKey,size:blob.size,mimeType:attachment ? attachmentMimeType(attachment.originalName,attachment.mimeType || blob.type) : blob.type,name:attachment?.originalName || 'image'};
        const hasher=sha256.create();
        const reader=blob.stream().getReader();
        while (true) { const chunk=await reader.read(); if (chunk.done) break; hasher.update(chunk.value); }
        digest=bytesToHex(hasher.digest());
      }
      manifest.push({key,digest});
      if (kind === 'record') {
        if (saved.get(key)?.digest !== digest) await this.request(connection,`/${jobId}/items`,'PUT',{key,kind,digest,payload,digestFormat:'canonical-json-v1'});
      } else {
        const blob: Blob=row.record.value;
        let offset=saved.get(key)?.digest === digest ? saved.get(key).offset || 0 : 0;
        if (offset > blob.size) throw new Error('The server returned an invalid upload offset.');
        do {
          if (offset === blob.size && saved.get(key)?.digest === digest) break;
          const bytes=new Uint8Array(await blob.slice(offset,offset+262144).arrayBuffer());
          let text=''; for (let i=0;i<bytes.length;i+=8192) text+=String.fromCharCode(...bytes.subarray(i,i+8192));
          const response=await this.request(connection,`/${jobId}/items`,'PUT',{key,kind,digest,payload,offset,base64:btoa(text)});
          offset=response.offset;
        } while (offset < blob.size);
      }
      this.progress$.next(`Moving ${manifest.length} items…`);
    }
    const key = 'record:preferences:account-preferences';
    const payload = {type:'preferences',value:{syncId:'account-preferences',...snapshot.preferences}};
    const digest = bytesToHex(sha256(new TextEncoder().encode(canonicalJson(payload))));
    if (saved.get(key)?.digest !== digest) await this.request(connection,`/${jobId}/items`,'PUT',{key,kind:'record',payload,digest,digestFormat:'canonical-json-v1'});
    manifest.push({key,digest});
    return manifest;
  }
}
