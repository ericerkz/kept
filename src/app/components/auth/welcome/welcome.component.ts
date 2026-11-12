import { uiText } from 'src/app/i18n/messages';
import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { registerPlugin, Capacitor } from '@capacitor/core';
import { WorkspaceService } from '../../../services/workspace.service';

// Native apps supply availability and the checkout flow; welcome-screen
// presentation and wording are shared across iOS and Android.
interface ManagedHostingOffering {
  available: boolean;
  title: string;
  description: string;
  price?: string;
  trialDays?: number;
  priceLabel?: string;
  badge?: string;
}

interface ManagedHostingPlugin {
  getOffering(): Promise<ManagedHostingOffering>;
  start(): Promise<void>;
}

@Component({
  selector: 'app-welcome', standalone: false,
  styleUrls: ['../auth-shared.scss', './welcome.component.scss'],
  templateUrl: './welcome.component.html'
})
export class WelcomeComponent implements OnInit {
  // Native builds supply the available hosting offer and sign-up flow.
  readonly managedHostingSignupEnabled = true;
  busy = false;
  error = '';
  managedHostingOffering: ManagedHostingOffering | null = null;
  constructor(public workspace: WorkspaceService, private router: Router) {}

  get cloudOptionLabelledBy() {
    return 'cloud-option-title'
      + (this.managedHostingOffering?.price ? ' cloud-option-price' : '')
      + (this.managedHostingOffering?.trialDays ? ' cloud-option-trial' : '');
  }

  async ngOnInit() {
    if (!this.managedHostingSignupEnabled || !Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('KeptManagedHosting')) return;
    try {
      const offering = await registerPlugin<ManagedHostingPlugin>('KeptManagedHosting').getOffering();
      if (offering?.available) {
        this.managedHostingOffering = {
          ...offering,
          trialDays: typeof offering.trialDays === 'number' && Number.isSafeInteger(offering.trialDays) && offering.trialDays > 0
            ? offering.trialDays : undefined
        };
      }
    } catch { /* no managed-hosting option configured on this build */ }
  }

  async useLocal() {
    this.busy = true;
    try { await this.workspace.createLocal(); await this.router.navigateByUrl('/'); }
    catch (error) { this.error = error instanceof Error ? (error.message) : (uiText('welcome.could_not_create_local_storage')); }
    finally { this.busy = false; }
  }
  async connect() {
    this.busy = true;
    try {
      if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('KeptWorkspace')) {
        await registerPlugin<{ chooseServer(): Promise<void> }>('KeptWorkspace').chooseServer();
      } else await this.router.navigateByUrl('/login');
    } catch (error) { this.error = error instanceof Error ? (error.message) : (uiText('welcome.could_not_open_server_setup')); }
    finally { this.busy = false; }
  }
  async startManagedHosting() {
    this.busy = true;
    try {
      await registerPlugin<ManagedHostingPlugin>('KeptManagedHosting').start();
      await this.router.navigateByUrl('/');
    } catch (error) { this.error = error instanceof Error ? (error.message) : (uiText('welcome.could_not_open_sign_up')); }
    finally { this.busy = false; }
  }
}
