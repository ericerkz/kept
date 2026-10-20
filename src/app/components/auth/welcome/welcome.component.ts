import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { registerPlugin, Capacitor } from '@capacitor/core';
import { WorkspaceService } from '../../../services/workspace.service';

@Component({
  selector: 'app-welcome', standalone: false,
  styleUrls: ['../auth-shared.scss'],
  template: `<main class="auth-page"><section class="auth-panel">
    <div class="brand-row"><img src="assets/images/keep2x.fw.png" width="49" alt="Kept"><span>Kept</span></div>
    <h1>Your notes, your way</h1>
    <p>Keep your notes on this device, or connect to your own Kept server.</p>
    @if (error) { <p class="error" role="alert">{{error}}</p> }
    @if (workspace.canUseLocal) {
      <button type="button" class="btn-primary" [disabled]="busy" (click)="useLocal()">Use on this device</button>
      <p>No account or server needed. Notes stay on this device. You can back them up or move them to a server later.</p>
    }
    <button type="button" class="btn-secondary" [disabled]="busy" (click)="connect()">Connect to a server</button>
  </section></main>`
})
export class WelcomeComponent {
  busy = false;
  error = '';
  constructor(public workspace: WorkspaceService, private router: Router) {}
  async useLocal() {
    this.busy = true;
    try { await this.workspace.createLocal(); await this.router.navigateByUrl('/'); }
    catch (error) { this.error = error instanceof Error ? error.message : 'Could not create local storage.'; }
    finally { this.busy = false; }
  }
  async connect() {
    this.busy = true;
    try {
      if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('KeptWorkspace')) {
        await registerPlugin<{ chooseServer(): Promise<void> }>('KeptWorkspace').chooseServer();
      } else await this.router.navigateByUrl('/login');
    } catch (error) { this.error = error instanceof Error ? error.message : 'Could not open server setup.'; }
    finally { this.busy = false; }
  }
}
