import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { Workspace, WorkspacePreferences } from '../interfaces/workspace';
import { createUuid } from '../utils/uuid';
import { OfflineStoreService } from './offline-store.service';

@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly selectionKey = 'kept_active_workspace';
  readonly local$ = new BehaviorSubject<Workspace | null>(null);
  readonly ready: Promise<void>;
  private initialized = false;

  constructor(private store: OfflineStoreService) { this.ready = this.initialize(); }

  get isLocal() { return !!this.local$.value || !!localStorage.getItem(this.selectionKey); }
  get local() { return this.local$.value; }
  get canUseLocal() { return Capacitor.isNativePlatform(); }
  get needsChoice() {
    return this.canUseLocal && !this.isLocal && !localStorage.getItem('gk_session') &&
      !(window as Window & { KEPT_API_URL?: string }).KEPT_API_URL;
  }

  private async initialize() {
    const id = localStorage.getItem(this.selectionKey);
    if (id) {
      const workspace = await this.store.getWorkspace(id);
      if (!workspace || workspace.mode !== 'local' || workspace.status === 'staging') {
        throw new Error('The selected workspace is unavailable. Your stored data has been preserved.');
      }
      this.local$.next(workspace);
    }
    this.initialized = true;
  }

  async createLocal(status: Workspace['status'] = 'active') {
    if (!this.initialized) await this.ready;
    const id = createUuid();
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id, partition: `local:${id}`, mode: 'local', generation: createUuid(), status,
      createdAt: now, updatedAt: now, nextId: 1, revision: 0,
      preferences: { theme: 'light', followSystemTheme: true, showPastReminders: false }
    };
    await this.store.saveWorkspace(workspace);
    if (status === 'active') await this.activate(workspace);
    void navigator.storage?.persist?.().catch(() => false);
    return workspace;
  }

  async activate(workspace: Workspace) {
    if (workspace.mode !== 'local' || workspace.status !== 'active') throw new Error('Workspace is not ready to open.');
    localStorage.setItem(this.selectionKey, workspace.id);
    this.local$.next(workspace);
    window.dispatchEvent(new CustomEvent('kept-workspace-changed', { detail: { id: workspace.id, generation: workspace.generation } }));
  }

  async refresh() {
    if (this.local) {
      const value = await this.store.getWorkspace(this.local.id);
      if (value) this.local$.next(value);
    }
  }

  async updatePreferences(patch: Partial<WorkspacePreferences>) {
    if (!this.local) throw new Error('No local workspace is open.');
    const value = await this.store.patchWorkspace(this.local.id, previous=>({preferences:{...previous.preferences,...patch},revision:previous.revision+1}));
    this.local$.next(value);
    return value.preferences;
  }

  async selectServer() {
    if (this.local?.status === 'frozen') throw new Error('Finish or cancel the transfer before switching workspaces.');
    localStorage.removeItem(this.selectionKey);
    this.local$.next(null);
  }

  async storageUsage() { return navigator.storage?.estimate?.() || {}; }
}
