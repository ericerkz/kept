import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { registerPlugin, Capacitor } from '@capacitor/core';
import { WorkspaceService } from '../../../services/workspace.service';

// A generic, provider-agnostic extension point: any managed-hosting
// provider's native app can register a plugin by this name and offer a
// third onboarding option here. This component never hardcodes a
// provider's name, pricing, or copy - whatever the plugin returns is
// displayed verbatim, the same way managed-hosting metadata is shown
// generically elsewhere in Settings. See docs/managed-hosting.md.
interface ManagedHostingOffering {
  available: boolean;
  title: string;
  description: string;
  priceLabel?: string;
  badge?: string;
}

interface ManagedHostingPlugin {
  getOffering(): Promise<ManagedHostingOffering>;
  start(): Promise<void>;
}

@Component({
  selector: 'app-welcome', standalone: false,
  styleUrls: ['../auth-shared.scss'],
  styles: [`
    .welcome-panel { max-width: 460px; }
    .welcome-panel > p { color: #bdc1c6; font-family: Roboto, Arial, sans-serif; line-height: 1.5; margin: 0 0 24px; }
    .welcome-options { display: flex; flex-direction: column; gap: 14px; }
    .welcome-option {
      align-items: center; background: transparent; border: 1.5px solid #5f6368; border-radius: 16px; color: inherit;
      cursor: pointer; display: flex; font: inherit; gap: 16px; min-height: 92px; padding: 18px 18px; text-align: left; width: 100%;
      transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease;
    }
    .welcome-option:active { transform: scale(.985); }
    .welcome-option:disabled { cursor: default; opacity: .6; }
    .welcome-option .lead {
      align-items: center; border-radius: 14px; display: inline-flex; flex: 0 0 52px; height: 52px; justify-content: center; width: 52px;
    }
    .welcome-option .lead .material-symbols-outlined { font-size: 28px; }
    .welcome-option .text { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
    .welcome-option strong { font-family: "Google Sans", Roboto, Arial, sans-serif; font-size: 18px; font-weight: 600; line-height: 1.25; }
    .welcome-option small { font-family: Roboto, Arial, sans-serif; font-size: 13.5px; line-height: 1.4; opacity: .82; }
    .welcome-option .chevron { flex: 0 0 auto; opacity: .7; }
    .welcome-option.primary { background: #feefc3; border-color: #feefc3; box-shadow: 0 6px 18px rgb(251 188 4 / 28%); color: #202124; }
    .welcome-option.primary .lead { background: #fbbc04; color: #202124; }
    .welcome-option.secondary { border-color: #8ab4f8; color: #8ab4f8; }
    .welcome-option.secondary .lead { background: rgb(138 180 248 / 16%); color: #8ab4f8; }
    .welcome-option.secondary small { color: #bdc1c6; }
    :host-context(.light-theme) .welcome-option.secondary { border-color: #1a73e8; color: #1a73e8; }
    :host-context(.light-theme) .welcome-option.secondary .lead { background: rgb(26 115 232 / 12%); color: #1a73e8; }
    :host-context(.light-theme) .welcome-option.secondary small { color: #5f6368; }
    .welcome-option .badge {
      background: #34a853; border-radius: 999px; color: #fff; flex: 0 0 auto; font-family: Roboto, Arial, sans-serif;
      font-size: 11px; font-weight: 700; letter-spacing: .02em; padding: 3px 9px; text-transform: uppercase;
    }
  `],
  template: `<main class="auth-page"><section class="auth-panel welcome-panel">
    <div class="brand-row"><img src="assets/images/keep2x.fw.png" width="49" alt="Kept"><span>Kept</span></div>
    <h1>Your notes, your way</h1>
    <p>Keep your notes on this device, or connect to your own Kept server.</p>
    @if (error) { <p class="error" role="alert">{{error}}</p> }
    <div class="welcome-options">
      @if (workspace.canUseLocal) {
        <button type="button" class="welcome-option primary" aria-label="Use on this device" [disabled]="busy" (click)="useLocal()">
          <span class="lead"><span class="material-symbols-outlined" aria-hidden="true">smartphone</span></span>
          <span class="text"><strong>Use on this device</strong><small>No account or server needed. Notes stay on this device. Back them up or move them to a server later.</small></span>
          <span class="material-symbols-outlined chevron" aria-hidden="true">chevron_right</span>
        </button>
      }
      @if (managedHostingSignupEnabled && managedHostingOffering?.available) {
        <button type="button" class="welcome-option primary" [attr.aria-label]="managedHostingOffering?.title" [disabled]="busy" (click)="startManagedHosting()">
          <span class="lead"><span class="material-symbols-outlined" aria-hidden="true">cloud</span></span>
          <span class="text">
            <strong>{{managedHostingOffering?.title}}
              @if (managedHostingOffering?.badge) { <span class="badge">{{managedHostingOffering?.badge}}</span> }
            </strong>
            <small>{{managedHostingOffering?.description}}</small>
            @if (managedHostingOffering?.priceLabel) { <small>{{managedHostingOffering?.priceLabel}}</small> }
          </span>
          <span class="material-symbols-outlined chevron" aria-hidden="true">chevron_right</span>
        </button>
      }
      <button type="button" class="welcome-option secondary" aria-label="Have a server? Connect to a server" [disabled]="busy" (click)="connect()">
        <span class="lead"><span class="material-symbols-outlined" aria-hidden="true">dns</span></span>
        <span class="text"><strong>Have a server?</strong><small>Connect to your own Kept server to sync, share and use your notes anywhere.</small></span>
        <span class="material-symbols-outlined chevron" aria-hidden="true">chevron_right</span>
      </button>
    </div>
  </section></main>`
})
export class WelcomeComponent implements OnInit {
  // Kept Cloud signup is not ready to ship. Re-enable for its launch; the
  // welcome card and native KeptManagedHosting integration are retained below.
  readonly managedHostingSignupEnabled = false;
  busy = false;
  error = '';
  managedHostingOffering: ManagedHostingOffering | null = null;
  constructor(public workspace: WorkspaceService, private router: Router) {}

  async ngOnInit() {
    if (!this.managedHostingSignupEnabled || !Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('KeptManagedHosting')) return;
    try {
      const offering = await registerPlugin<ManagedHostingPlugin>('KeptManagedHosting').getOffering();
      if (offering?.available) this.managedHostingOffering = offering;
    } catch { /* no managed-hosting option configured on this build */ }
  }

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
  async startManagedHosting() {
    this.busy = true;
    try {
      await registerPlugin<ManagedHostingPlugin>('KeptManagedHosting').start();
      await this.router.navigateByUrl('/');
    } catch (error) { this.error = error instanceof Error ? error.message : 'Could not open sign-up.'; }
    finally { this.busy = false; }
  }
}
