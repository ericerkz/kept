import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { WorkspaceService } from './workspace.service';

interface CloudMove { workspaceId: string; generation: string; }
interface HostingSignupPlugin {
  getOffering(): Promise<{ available: boolean; price?: string; trialDays?: number }>;
  start(): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class DeviceServerMoveService {
  // Install-wide markers: never versioned, exported with notes, or reset by a restore.
  private readonly inviteKey = 'kept_device_sync_invite_shown';
  private readonly moveKey = 'kept_device_cloud_move';
  private resumeAfterReload = this.readMove();
  private readonly plugin = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('KeptManagedHosting')
    ? registerPlugin<HostingSignupPlugin>('KeptManagedHosting') : null;
  readonly ready: Promise<void>;
  cloudAvailable = false;
  cloudPrice?: string;
  cloudTrialDays?: number;

  constructor(private workspace: WorkspaceService, private router: Router) {
    this.ready = this.loadOffering();
  }

  private async loadOffering() {
    try {
      const offering = await this.plugin?.getOffering();
      this.cloudAvailable = !!offering?.available;
      this.cloudPrice = offering?.price;
      this.cloudTrialDays = this.cloudAvailable && typeof offering?.trialDays === 'number'
        && Number.isSafeInteger(offering.trialDays) && offering.trialDays > 0 ? offering.trialDays : undefined;
    } catch {
      this.cloudAvailable = false;
      this.cloudPrice = undefined;
      this.cloudTrialDays = undefined;
    }
  }

  private readMove(): CloudMove | null {
    try {
      const move = JSON.parse(localStorage.getItem(this.moveKey) || 'null');
      return typeof move?.workspaceId === 'string' && typeof move?.generation === 'string' ? move : null;
    } catch { return null; }
  }

  get pendingCloudMove() {
    const move = this.readMove(), local = this.workspace.local;
    return !!local && local.id === move?.workspaceId && local.generation === move?.generation;
  }

  claimInvite() {
    if (!this.cloudAvailable || !this.workspace.canUseLocal || !this.workspace.isLocal ||
        !this.workspace.local || this.workspace.local.status !== 'active' || this.pendingCloudMove) return false;
    try {
      if (localStorage.getItem(this.inviteKey)) return false;
      // Mark on first display, rather than dismissal, so reopening never repeats it.
      localStorage.setItem(this.inviteKey, '1');
      return localStorage.getItem(this.inviteKey) === '1';
    } catch { return false; } // Don't show a repeating invitation if persistence is unavailable.
  }

  openCloudMove() {
    return this.router.navigate(['/settings'], { queryParams: { move: 'cloud' } });
  }

  async startCloud() {
    await this.ready;
    const local = this.workspace.local;
    if (!this.cloudAvailable || !this.plugin) throw new Error('Update the native Kept app to set up Kept Cloud.');
    if (!local || !this.workspace.canUseLocal) throw new Error('Open your device notes before moving them.');
    const move: CloudMove = { workspaceId: local.id, generation: local.generation };
    // Persist before opening native sign-up: both shells reload after configuration.
    // This holds no credentials and does not switch or modify the local library.
    localStorage.setItem(this.moveKey, JSON.stringify(move));
    this.resumeAfterReload = null;
    try { await this.plugin.start(); }
    catch (error) { this.cancelCloudMove(); throw error; }
  }

  async resumeCloudMove() {
    const pending = this.resumeAfterReload;
    this.resumeAfterReload = null;
    await this.workspace.ready;
    if (!pending || !this.pendingCloudMove) return false;
    return this.router.navigate(['/settings'], { queryParams: { move: 'cloud', resume: '1' }, replaceUrl: true });
  }

  cancelCloudMove() {
    localStorage.removeItem(this.moveKey);
    this.resumeAfterReload = null;
  }
}
