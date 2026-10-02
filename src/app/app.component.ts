import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { NavigationEnd, Router } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { PushNotificationService } from './services/push-notification.service';
import { SharedService } from './services/shared.service';
import { ShareIntentsService } from './services/share-intents.service';
import { AuthService } from './services/auth.service';

type AppBackButtonEvent = { canGoBack?: boolean };
type PluginListenerHandle = { remove: () => Promise<void> | void };
type CapacitorAppPlugin = {
  addListener: (
    eventName: 'backButton' | 'appUrlOpen',
    listenerFunc: (event: AppBackButtonEvent & { url?: string }) => void
  ) => Promise<PluginListenerHandle>;
  exitApp?: () => Promise<void>;
};

const CapacitorApp = registerPlugin<CapacitorAppPlugin>('App');

@Component({
    selector: 'app-root',
    template: `
      <router-outlet></router-outlet>
      <app-reminder-notification></app-reminder-notification>
      @if (notificationPromptVisible) {
        <div class="notification-permission-card" role="region" aria-label="Notification permission prompt">
          <button type="button" class="notification-permission-close" aria-label="Dismiss notification prompt"
            (click)="dismissNotificationPrompt()">×</button>
          <div class="notification-permission-title">Enable notifications?</div>
          <p>Kept can send reminder alerts and important notification updates from this device.</p>
          <button type="button" class="notification-permission-enable" (click)="enableNotifications()">Enable</button>
        </div>
      }
    `,
    styles: [`
      .notification-permission-card {
        background: #fff8dc;
        border: 1px solid #fbbc04;
        border-radius: 8px;
        bottom: 18px;
        box-shadow: 0 6px 18px rgb(60 64 67 / 22%);
        color: #202124;
        left: 18px;
        max-width: min(360px, calc(100vw - 36px));
        padding: 16px 48px 16px 18px;
        position: fixed;
        z-index: 1200;
      }

      .notification-permission-title {
        font: 600 15px 'Google Sans', Roboto, Arial, sans-serif;
        margin-bottom: 6px;
      }

      .notification-permission-card p {
        color: #5f6368;
        font: 400 13px/1.4 Roboto, Arial, sans-serif;
        margin: 0 0 12px;
      }

      .notification-permission-close {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: 50%;
        color: #7d6a28;
        cursor: pointer;
        display: flex;
        font: 500 24px/1 Roboto, Arial, sans-serif;
        height: 32px;
        justify-content: center;
        padding: 0;
        position: absolute;
        right: 8px;
        top: 8px;
        width: 32px;
      }

      .notification-permission-close:hover {
        background: rgb(251 188 4 / 16%);
        color: #202124;
      }

      .notification-permission-enable {
        background: #fbbc04;
        border: 0;
        border-radius: 6px;
        color: #202124;
        cursor: pointer;
        font: 600 13px 'Google Sans', Roboto, Arial, sans-serif;
        padding: 8px 14px;
      }

      .notification-permission-enable:hover {
        background: #f9ab00;
      }
    `],
    standalone: false
})
export class AppComponent implements OnInit, OnDestroy {
  private androidBackButtonHandle?: PluginListenerHandle;
  private oidcDeepLinkHandle?: PluginListenerHandle;
  private notificationPromptResetListener?: () => void;
  private notificationPromptVisibilityListener?: () => void;
  private notificationPromptFocusListener?: () => void;
  private notificationPromptTimer?: number;
  private routerSubscription?: Subscription;
  notificationPromptVisible = false;

  constructor(
    private push: PushNotificationService,
    private shared: SharedService,
    private shareIntents: ShareIntentsService,
    private auth: AuthService,
    private ngZone: NgZone,
    private router: Router
  ) {}

  ngOnInit() {
    this.shared.initPwa();
    this.shareIntents.init().catch(console.error);
    this.registerAndroidBackButton();
    this.registerOidcDeepLinkHandler();
    this.notificationPromptResetListener = () => {
      this.ngZone.run(() => this.refreshNotificationPrompt(true));
    };
    this.notificationPromptVisibilityListener = () => {
      if (document.visibilityState === 'visible') {
        this.ngZone.run(() => this.refreshNotificationPrompt());
      }
    };
    this.notificationPromptFocusListener = () => {
      this.ngZone.run(() => this.refreshNotificationPrompt());
    };
    window.addEventListener('kept-notification-permission-reprompt', this.notificationPromptResetListener);
    document.addEventListener('visibilitychange', this.notificationPromptVisibilityListener);
    window.addEventListener('focus', this.notificationPromptFocusListener);
    this.routerSubscription = this.router.events
      .pipe(filter(event => event instanceof NavigationEnd))
      .subscribe(() => this.refreshNotificationPrompt());

    // Delay slightly so the app chrome settles before showing an optional prompt.
    setTimeout(() => this.refreshNotificationPrompt(), 2000);
    this.notificationPromptTimer = window.setInterval(() => this.refreshNotificationPrompt(), 30000);
  }

  ngOnDestroy() {
    this.shareIntents.destroy().catch(console.error);
    this.androidBackButtonHandle?.remove();
    this.oidcDeepLinkHandle?.remove();
    if (this.notificationPromptResetListener) {
      window.removeEventListener('kept-notification-permission-reprompt', this.notificationPromptResetListener);
    }
    if (this.notificationPromptVisibilityListener) {
      document.removeEventListener('visibilitychange', this.notificationPromptVisibilityListener);
    }
    if (this.notificationPromptFocusListener) {
      window.removeEventListener('focus', this.notificationPromptFocusListener);
    }
    if (this.notificationPromptTimer) {
      window.clearInterval(this.notificationPromptTimer);
    }
    this.routerSubscription?.unsubscribe();
  }

  dismissNotificationPrompt() {
    this.push.dismissNotificationPermissionPrompt();
    this.notificationPromptVisible = false;
  }

  async enableNotifications() {
    const permission = await this.push.requestPermissionFromGesture();
    this.notificationPromptVisible = permission === 'default' && this.push.shouldShowNotificationPermissionPrompt();
  }

  private refreshNotificationPrompt(force = false) {
    if (force) this.push.restoreNotificationPermissionPrompt();
    this.notificationPromptVisible = this.push.shouldShowNotificationPermissionPrompt();
  }

  private async registerAndroidBackButton() {
    if (Capacitor.getPlatform() !== 'android') return;

    try {
      this.androidBackButtonHandle = await CapacitorApp.addListener('backButton', event => {
        this.ngZone.run(() => this.handleAndroidBackButton(event));
      });
    } catch (error) {
      console.warn('Android back button listener unavailable', error);
    }
  }

  private async registerOidcDeepLinkHandler() {
    if (!Capacitor.isNativePlatform()) return;

    try {
      this.oidcDeepLinkHandle = await CapacitorApp.addListener('appUrlOpen', event => {
        if (!event?.url) return;
        this.ngZone.run(() => this.handleOidcDeepLink(event.url || ''));
      });
    } catch (error) {
      console.warn('OIDC deep link listener unavailable', error);
    }
  }

  private handleOidcDeepLink(rawUrl: string) {
    let url: URL;
    try { url = new URL(rawUrl); } catch { return; }
    if (url.protocol !== 'kept:' || url.hostname !== 'auth' || url.pathname !== '/oidc') return;

    const oidcCode = url.searchParams.get('oidc_code');
    const oidcError = url.searchParams.get('oidc_error');
    const oidcLink = url.searchParams.get('oidc_link');
    const oauthRequest = url.searchParams.get('oauth_request');
    const params = new URLSearchParams();
    this.auth.suppressSessionExpiredNotice();

    if (oidcCode) {
      params.set('oidc_code', oidcCode);
      if (oauthRequest) params.set('oauth_request', oauthRequest);
      this.router.navigateByUrl(`/login?${params.toString()}`);
      return;
    }

    if (oidcError) {
      params.set('oidc_error', oidcError);
      if (oauthRequest) params.set('oauth_request', oauthRequest);
      this.router.navigateByUrl(`/login?${params.toString()}`);
      return;
    }

    if (oidcLink) {
      params.set('oidc_link', oidcLink);
      this.router.navigateByUrl(`/settings?${params.toString()}`);
    }
  }

  private handleAndroidBackButton(event: AppBackButtonEvent) {
    if (this.closeOpenTooltip()) return;

    if (this.shared.selectedNoteIds.value.length) {
      this.shared.clearNoteSelection();
      return;
    }

    if (this.isNoteModalOpen()) {
      this.shared.saveNote.next(true);
      return;
    }

    if (document.querySelector('app-input.mobile-active')) {
      this.shared.closeMobileComposer.next(true);
      return;
    }

    if (this.isSidebarOpen()) {
      this.shared.closeSideBarIfOpen.next(true);
      return;
    }

    if (this.router.url !== '/' || event.canGoBack) {
      window.history.back();
      return;
    }

    CapacitorApp.exitApp?.();
  }

  private closeOpenTooltip() {
    const tooltipEl = document.querySelector<HTMLDivElement>('[data-tooltip="true"][data-is-tooltip-open="true"]');
    if (!tooltipEl) return false;
    this.shared.closeTooltip(tooltipEl);
    return true;
  }

  private isNoteModalOpen() {
    const modal = document.querySelector<HTMLElement>('app-notes .modal-container');
    if (!modal) return false;
    return getComputedStyle(modal).display !== 'none';
  }

  private isSidebarOpen() {
    const sidebar = document.querySelector<HTMLElement>('[sideBar]');
    return !!sidebar && !sidebar.classList.contains('close') && !!document.querySelector('.sidebar-backdrop');
  }
}
