import { attachmentMimeType } from '../utils/attachments';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createUuid } from '../utils/uuid';
import { Injectable, NgZone } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { NativeAction, NativeCapabilities, Workspace } from '../interfaces/workspace';
import { ReminderI } from '../interfaces/reminder';
import { NoteI } from '../interfaces/notes';
import { sanitizeNoteHtml } from '../utils/note-html';
import { AuthService } from './auth.service';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';

export interface KeptWorkspacePlugin {
  getCapabilities(): Promise<NativeCapabilities>;
  activateWorkspace(input: {workspace: Workspace; activation: number}): Promise<void>;
  chooseServer(): Promise<void>;
  forgetServer(): Promise<void>;
  prepareServerConnection(): Promise<{ connectionId: string; url: string; accountId: number; token: string; headers?: Record<string,string> }>;
  activateServer(input: { connectionId: string; sourceWorkspaceId: string; sourceGeneration: string }): Promise<void>;
  listActions(input: { limit: number; workspaceId: string }): Promise<{ actions: NativeAction[] }>;
  acknowledgeActions(input: { actionIds: string[] }): Promise<void>;
  quarantineActions(input: { actionIds: string[]; reason: string }): Promise<void>;
  // Benign native rejections use code STALE_SNAPSHOT or INACTIVE_WORKSPACE.
  publishSnapshot(input: { workspace: Workspace; revision: number; page: number; complete: boolean; notes: unknown[] }): Promise<void>;
  syncReminders(input: { workspace: Workspace; reminders: unknown[]; projectionRevision: number }): Promise<{ exact?: boolean; skipped?: Array<{ id: string; reason: string }> }>;
  cancelReminders(input: { workspaceId: string; generation: string; reminderSyncIds?: string[]; dismissOnly?: boolean }): Promise<void>;
  requestRemindersPermission(input: { appleAccountDisclosureAccepted: boolean }): Promise<{ granted: boolean }>;
  beginExport(input: { name: string; mimeType: string }): Promise<{ reference: string }>;
  writeExportChunk(input: { reference: string; offset: number; base64: string }): Promise<void>;
  finishExport(input: { reference: string }): Promise<void>;
  abortExport(input: { reference: string }): Promise<void>;
  chooseImport(): Promise<{ reference: string; size: number }>;
  readFileChunk(input: { reference: string; offset: number; length: number }): Promise<{ base64: string }>;
  releaseImport(input: { reference: string }): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class NativeWorkspaceService {
  readonly capabilities$ = new BehaviorSubject<NativeCapabilities | null>(null);
  readonly occurrences$ = new Subject<ReminderI>();
  private activation = 0;
  private activationIdentity = '';
  readonly error$ = new BehaviorSubject('');
  readonly locationPermissionRequired$ = new BehaviorSubject(false);
  readonly ready: Promise<void>;
  private tail = Promise.resolve();
  private reminderTail = Promise.resolve();
  private revisionPublished = '';
  readonly plugin = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('KeptWorkspace')
    ? registerPlugin<KeptWorkspacePlugin>('KeptWorkspace') : null;

  constructor(private auth: AuthService, private sync: OfflineSyncService, private store: OfflineStoreService, private zone: NgZone) {
    this.ready = this.initialize();
    const resume = () => { if (document.visibilityState === 'visible') void this.flush().catch(error => this.report(error)); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    if (Capacitor.isNativePlatform()) {
      const app = registerPlugin<{ addListener(name: string, callback: () => void): Promise<unknown> }>('App');
      void app.addListener('resume', () => void this.flush().catch(error => this.report(error))).catch(() => undefined);
    }
    this.auth.accessChanges$.subscribe(() => { this.revisionPublished = ''; this.locationPermissionRequired$.next(false); void this.flush().catch(error => this.report(error)); });
    this.sync.cacheChanged$.subscribe(() => { void this.flush().catch(error => this.report(error)); });
  }

  private async initialize() {
    if (!this.plugin) return;
    try {
      const capabilities = await this.plugin.getCapabilities();
      if (capabilities.version !== 1) throw new Error('The native workspace integration needs an app update.');
      this.capabilities$.next(capabilities);
    } catch (error) { this.report(error); }
  }

  private report(error: unknown) {
    this.zone.run(() => this.error$.next(error instanceof Error ? error.message : 'Could not update the native workspace.'));
  }

  private flushOperation?: Promise<void>;
  private flushAgain = false;
  flush() {
    if (this.flushOperation) {this.flushAgain = true;return this.flushOperation;}
    const operation = this.tail.then(async () => {
      do {this.flushAgain = false;await this.flushOnce();} while (this.flushAgain);
    });
    this.tail = operation.catch(error=>this.report(error));
    this.flushOperation = operation.finally(()=>this.flushOperation = undefined);
    return this.flushOperation;
  }

  private async flushOnce() {
      await this.ready;
      if (!this.plugin || !this.capabilities$.value?.durableActions || !this.sync.partition) return;
      const workspace = await this.sync.workspace();
      await this.ensureActive(workspace);
      while (true) {
      const { actions } = await this.plugin.listActions({ limit: 100, workspaceId: workspace.id });
      for (const action of [...actions].sort((a, b) => a.sequence - b.sequence)) {
        if (this.sync.partition !== workspace.partition) return;
        if (action.workspaceId !== workspace.id) continue;
        if (action.generation !== workspace.generation || workspace.status !== 'active') {
          await this.store.recordConflict(workspace.partition,action.actionId,action,'Workspace generation is no longer active.');
          await this.plugin.quarantineActions({ actionIds: [action.actionId], reason: 'Workspace generation is no longer active.' });
          continue;
        }
        try {
          if (!await this.store.hasReceipt(workspace.partition, action.actionId)) {
            await this.applyAction((await this.store.getWorkspace(workspace.id))!, action);
          }
        } catch (error) {
          if (this.sync.partition !== workspace.partition) return;
          const name = error instanceof Error || error instanceof DOMException ? error.name : '';
          const message = error instanceof Error || error instanceof DOMException ? error.message : '';
          if (['QuotaExceededError','AbortError','UnknownError','InvalidStateError','NotFoundError','VersionError','KeptPermissionRequired'].includes(name) || /local write|indexeddb|database|storage/i.test(message)) throw error;
          await this.store.recordConflict(workspace.partition, action.actionId, action, error instanceof Error ? error.message : 'Native action conflict.');
          await this.plugin.quarantineActions({ actionIds: [action.actionId], reason: 'The action was retained in Kept for recovery.' });
          this.report(error); continue;
        }
        await this.plugin.acknowledgeActions({ actionIds: [action.actionId] });
      }
      if (actions.length < 100 || !actions.some(action=>action.workspaceId === workspace.id)) break;
      }
      await this.publish(workspace);
  }

  private async applyAction(workspace: Workspace, action: NativeAction) {
    if (!action.actionId || action.actionId.length > 160 || !action.targetSyncId || !Number.isSafeInteger(action.sequence)) throw new Error('Invalid native action identity.');
    const blobs: Array<{ key: string; value: Blob }> = [];
    const images: any[] = [];
    const attachments: Record<string,any>[] = [];
    for (const file of action.files || []) {
      const raster = ['image/png','image/jpeg','image/gif','image/webp'].includes(file.mimeType);
      if (!this.plugin || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > (raster ? 10 : 25) * 1024 * 1024) throw new Error('A captured file exceeds the supported size.');
      const mimeType = raster ? file.mimeType : attachmentMimeType(file.name,file.mimeType);
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for (let offset = 0; offset < file.size; offset += 256 * 1024) {
        const length = Math.min(256 * 1024, file.size - offset);
        const { base64 } = await this.plugin.readFileChunk({ reference: file.reference, offset, length });
        const chunk = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        if (chunk.length !== length) throw new Error('A staged capture file is incomplete.');
        chunks.push(chunk);
      }
      if (!raster) {
        const syncId = `attachment-${createUuid()}`;
        blobs.push({key:`attachment:${syncId}`,value:new Blob(chunks,{type:mimeType})});
        attachments.push({syncId,originalName:file.name,fileSize:file.size,mimeType,uploadedAt:new Date().toISOString()});
        continue;
      }
      const canonical = `/__kept_local_media/${encodeURIComponent(action.actionId)}-${images.length}`;
      blobs.push({ key: `media:${canonical}`, value: new Blob(chunks, { type: file.mimeType }) });
      images.push({ id: `${action.actionId}-${images.length}`, dataUrl: canonical, name: file.name, placement: 'top' });
    }
    if (blobs.length && action.kind !== 'note.upsert') throw new Error('Files must accompany a note capture.');
    const payload = { ...action.payload } as any;
    if (action.kind.startsWith('note.') || action.kind === 'checklist.set') {
      const previous = (await this.store.listNotes(workspace.partition)).find(note => note.syncId === action.targetSyncId);
      if (previous?.locked) throw new Error('Unlock the note in Kept before applying a queued structural edit.');
      if (action.kind === 'note.delete') {
        if (!previous) { await this.sync.commit('note.delete', action.targetSyncId, {}, { action }); return; }
        if (action.baseRevision !== undefined && action.baseRevision !== workspace.revision) throw new Error('A queued deletion conflicts with newer edits.');
        await this.sync.commit('note.delete', action.targetSyncId, previous, { action }); return;
      }
      if (action.kind === 'checklist.set') {
        if (!previous) throw new Error('The checklist no longer exists.');
        const checkbox = previous.checkBoxes?.find(item => item.id === payload.checkboxId);
        if (!checkbox || typeof payload.done !== 'boolean') throw new Error('A queued checklist edit no longer matches the note.');
        await this.sync.commit('note.upsert', action.targetSyncId, { ...previous,
          checkBoxes: previous.checkBoxes!.map(item => item.id === payload.checkboxId ? { ...item, done: payload.done } : item) }, { action });
        return;
      }
      if (previous && action.baseRevision !== workspace.revision) throw new Error('A queued note edit conflicts with newer edits.');
      const note: Partial<NoteI> = { pinned: false, bgColor: '', bgImage: '', isCbox: false, labels: [], archived: false, trashed: false, ...previous };
      for (const field of ['noteTitle', 'noteBody', 'bgColor', 'bgImage', 'pinned', 'archived', 'trashed', 'binder', 'isCbox'] as const) if (payload[field] !== undefined) (note as any)[field] = payload[field];
      note.noteTitle = sanitizeNoteHtml(String(note.noteTitle || ''));
      note.noteBody = sanitizeNoteHtml(String(note.noteBody || ''));
      if (payload.checkBoxes) note.checkBoxes = payload.checkBoxes.map((item: any) => ({ id: Number(item.id), done: item.done === true, data: sanitizeNoteHtml(String(item.data || '')), indentLevel: Math.min(4, Math.max(0, Number(item.indentLevel || 0))) }));
      if (images.length) note.images = [...(note.images || []), ...images];
      await this.sync.commit('note.upsert', action.targetSyncId, note, { action, blobs, attachments });
      return;
    }
    if (!['reminder.upsert', 'reminder.delete', 'reminder.occurrence'].includes(action.kind)) throw new Error('Unsupported native action.');
    const reminder = (await this.store.listReminders(workspace.partition)).find(item => item.syncId === action.targetSyncId);
    if (!reminder) {
      if (action.kind !== 'reminder.upsert') throw new Error('The reminder is no longer available.');
      const note = (await this.store.listNotes(workspace.partition)).find(note=>note.syncId === payload.noteSyncId);
      if (!note || note.locked) throw new Error('The queued reminder does not have an available unlocked note.');
      if (!payload.dueAtUtc && !payload.locationName) throw new Error('A queued reminder needs a date or location.');
      if (payload.dueAtUtc && !Number.isFinite(Date.parse(payload.dueAtUtc))) throw new Error('The queued reminder date is invalid.');
      let rule = payload.repeatRule;
      if (typeof rule === 'string') rule = JSON.parse(rule);
      if (Capacitor.getPlatform() === 'android' && rule && rule.type !== 'none' && !this.capabilities$.value?.androidRecurringReminders) throw new Error('Native recurring reminders need an app update.');
      if (!await this.requestReminderPermission()) {const error=new Error('Open reminder permissions to finish saving this queued reminder.');error.name='KeptPermissionRequired';throw error;}
      await this.sync.commit('reminder.upsert',action.targetSyncId,{
        noteId:note.id,noteSyncId:note.syncId,dueAtUtc:payload.dueAtUtc || null,timezone:payload.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        title:String(payload.title || 'Reminder'),body:String(payload.body || ''),imageUrl:null,status:'pending',repeatRule:rule ? JSON.stringify(rule) : null,
        locationName:payload.locationName || null,latitude:payload.latitude ?? null,longitude:payload.longitude ?? null,radiusMeters:payload.radiusMeters ?? null,
        locationTrigger:payload.locationTrigger || 'arrive',scheduleVersion:1,scheduleAnchorAtUtc:payload.dueAtUtc || null
      },{action});
      return;
    }
    if (action.kind === 'reminder.delete') {
      await this.sync.commit('reminder.delete', reminder.syncId!, reminder, { action }); return;
    }
    const patch: any = {};
    const incoming = payload.changes || payload;
    for (const key of ['title', 'body', 'dueAtUtc', 'timezone', 'repeatRule', 'status', 'managedExternally', 'externalRepeatRule']) {
      if (incoming[key] === undefined) continue;
      if (payload.base && JSON.stringify((reminder as any)[key]) !== JSON.stringify(payload.base[key])) {
        await this.store.recordConflict(workspace.partition, `${action.actionId}:${key}`, { action, current: reminder }, 'The local reminder field changed after the Apple snapshot.');
        continue;
      }
      patch[key] = incoming[key];
    }
    if (action.kind === 'reminder.occurrence') {
      if (Number(payload.scheduleVersion) !== Number((reminder as any).scheduleVersion || 1) || !payload.occurrenceId) throw new Error('The native reminder occurrence has an obsolete schedule.');
      patch.status = payload.nextDueAtUtc ? 'pending' : 'fired';
      if (payload.nextDueAtUtc) patch.dueAtUtc = payload.nextDueAtUtc;
      patch.lastOccurrenceId = payload.occurrenceId;
    }
    if (patch.dueAtUtc && !Number.isFinite(Date.parse(patch.dueAtUtc))) throw new Error('Native reminder has an invalid date.');
    if (patch.status && !['pending', 'fired', 'dismissed', 'snoozed'].includes(patch.status)) throw new Error('Native reminder has an invalid status.');
    await this.sync.commit(action.kind === 'reminder.occurrence' ? 'reminder.occurrence' : 'reminder.upsert', reminder.syncId!, { ...reminder, ...patch }, { action });
    if (action.kind === 'reminder.occurrence' && this.sync.partition === workspace.partition) this.occurrences$.next(reminder);
  }

  async publish(workspace?: Workspace) {
    workspace ||= await this.sync.workspace();
    if (!this.plugin || !this.capabilities$.value?.workspaceSnapshots) return;
    let current = workspace;
    try {
      const currentMeta = await this.store.getWorkspace(workspace.id);
      if (!currentMeta || currentMeta.generation !== workspace.generation || currentMeta.status !== 'active') return;
      const projection = await this.store.nativeProjection(workspace);
      current = projection.workspace;
      const key = `${current.id}:${current.generation}:${current.revision}`;
      if (key === this.revisionPublished) return;
      const notes = projection.notes;
      for (let offset = 0; offset < Math.max(notes.length, 1); offset += 50) {
        if (this.sync.partition !== workspace.partition) return;
        await this.plugin.publishSnapshot({ workspace: current, revision: current.revision, page: offset / 50,
          complete: offset + 50 >= notes.length, notes: notes.slice(offset, offset + 50).map(note => note.locked
            ? { id: note.id, syncId: note.syncId, locked: true, archived: note.archived, trashed: note.trashed }
            : { ...note, images: [], attachments: [] }) });
      }
      this.revisionPublished = key;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'STALE_SNAPSHOT' || code === 'INACTIVE_WORKSPACE') return;
      // A newer edit, generation or workspace may win while native awaits a page.
      if (this.sync.partition !== current.partition || this.sync.generation !== current.generation) return;
      const latest = await this.store.getWorkspace(current.id);
      if (!latest || latest.generation !== current.generation || latest.status !== 'active' || latest.revision > current.revision) return;
      throw error;
    }
  }

  private async ensureActive(workspace: Workspace) {
    if (!this.plugin) return;
    if (workspace.partition !== this.sync.partition) throw new Error('An inactive workspace cannot publish native state.');
    const identity = `${workspace.id}:${workspace.generation}`;
    if (this.activationIdentity === identity) return;
    this.activation = Math.max(Date.now(),Number(localStorage.getItem('kept_native_activation') || 0)+1,this.activation+1);
    localStorage.setItem('kept_native_activation',String(this.activation));
    this.activationIdentity = identity;
    try { await this.plugin.activateWorkspace({workspace,activation:this.activation}); }
    catch (error) { this.activationIdentity = ''; throw error; }
  }

  syncReminders(reminders: ReminderI[]) {
    // Keep cancellation and replacement in order when edits/resume overlap.
    const operation = this.reminderTail.then(() => this.syncRemindersNow(reminders));
    this.reminderTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async syncRemindersNow(reminders: ReminderI[]) {
    await this.ready;
    if (!this.plugin || !this.capabilities$.value) return;
    const projection = await this.store.nativeProjection(await this.sync.workspace());
    const workspace = projection.workspace;
    if (this.sync.partition !== workspace.partition || this.sync.generation !== workspace.generation) return;
    // Read all stored notes, not the current overview page (which omits Trash).
    const inactiveIds = new Set(projection.notes.filter(note => note.trashed || note.archived).map(note => note.id));
    const suppressed = reminders.filter(reminder => reminder.noteId !== null && inactiveIds.has(reminder.noteId));
    const eligible = reminders.filter(reminder => reminder.noteId === null || !inactiveIds.has(reminder.noteId));
    await this.ensureActive(workspace);
    const suppressedSyncIds = suppressed.map(reminder => reminder.syncId).filter((id): id is string => !!id);
    if (suppressedSyncIds.length) await this.plugin.cancelReminders({ workspaceId: workspace.id, generation: workspace.generation, reminderSyncIds: suppressedSyncIds });
    const result = await this.plugin.syncReminders({ workspace, projectionRevision: workspace.revision, reminders: eligible.map(reminder => ({
      ...reminder, workspaceId: workspace.id, generation: workspace.generation,
      reminderSyncId: reminder.syncId, scheduleVersion: (reminder as any).scheduleVersion || 1,
      scheduleAnchor: reminder.scheduleAnchorAtUtc || reminder.dueAtUtc,
      deepLink: `kept://note/${reminder.noteId}?workspace=${encodeURIComponent(workspace.id)}&generation=${workspace.generation}`
    })) });
    if (this.sync.partition !== workspace.partition || this.sync.generation !== workspace.generation) return result;
    this.zone.run(() => this.locationPermissionRequired$.next((result.skipped || []).some(skipped => skipped.reason === 'locationPermissionRequired')));
    for (const skipped of result.skipped || []) if (skipped.reason === 'invalid') this.report(new Error(`Invalid native reminder: ${skipped.id}`));
    if (result.exact === false) this.report(new Error('Android exact-alarm permission is off. Reminder delivery may be delayed. Enable precise reminders in Android settings.'));
    return result;
  }

  async cancelReminders(syncIds?: string[], dismissOnly = false) {
    if (!this.plugin) return;
    const workspace = await this.sync.workspace();
    await this.plugin.cancelReminders({ workspaceId: workspace.id, generation: workspace.generation, reminderSyncIds: syncIds, dismissOnly });
  }

  async recoverNote(action: NativeAction) {
    if (action.kind !== 'note.upsert') throw new Error('This change must be reviewed against the current note.');
    const workspace = await this.sync.workspace();
    const identity = `recovery-${bytesToHex(sha256(new TextEncoder().encode(`${workspace.id}:${workspace.generation}:${action.actionId}`)))}`;
    const recovered = {...action,actionId:identity,workspaceId:workspace.id,generation:workspace.generation,targetSyncId:`note-${identity}`,baseRevision:workspace.revision};
    if (!await this.store.hasReceipt(workspace.partition,identity)) await this.applyAction(workspace,recovered);
    await this.plugin?.acknowledgeActions({actionIds:[action.actionId]});
  }

  async openExactAlarmSettings() {
    if (Capacitor.getPlatform() === 'android') await registerPlugin<{openExactAlarmSettings():Promise<void>}>('KeptTimeReminders').openExactAlarmSettings();
  }

  async openBackgroundLocationSettings() {
    if (Capacitor.getPlatform() !== 'android') return;
    try {
      await registerPlugin<{openBackgroundLocationSettings():Promise<void>}>('KeptGeofence').openBackgroundLocationSettings();
    } catch (error) { this.report(error); }
  }

  async requestReminderPermission() {
    await this.ready;
    if (!this.plugin || !this.capabilities$.value?.durableActions) throw new Error('Update the native Kept app to use local reminders.');
    const workspace = await this.sync.workspace();
    let accepted = !!(workspace as any).appleReminderDisclosureAccepted;
    if (Capacitor.getPlatform() === 'ios' && !accepted) accepted = window.confirm('Kept uses Apple Reminders. Reminder content may synchronize through iCloud or another account configured in Apple Reminders. Continue?');
    if (Capacitor.getPlatform() !== 'ios') accepted = true;
    if (!accepted) return false;
    await this.store.patchWorkspace(workspace.id, { appleReminderDisclosureAccepted: true } as any);
    return (await this.plugin.requestRemindersPermission({ appleAccountDisclosureAccepted: accepted })).granted;
  }
}
