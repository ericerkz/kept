import { uiText } from 'src/app/i18n/messages';
import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from '../../services/auth.service';
import { ManagedHostingInfo, ManagedHostingNotice, ManagedHostingService } from '../../services/managed-hosting.service';

const DAY_MS = 24 * 60 * 60 * 1000;
type Dismissal = { notice: string; until: number };

@Component({
  selector: 'app-managed-notice-banner',
  templateUrl: './managed-notice-banner.component.html',
  styleUrls: ['./managed-notice-banner.component.scss'],
  standalone: false
})
export class ManagedNoticeBannerComponent implements OnInit, AfterViewInit, OnDestroy {
  info: ManagedHostingInfo | null = null;
  notice: ManagedHostingNotice | null = null;
  private readonly dismissalKey = `kept_managed_notice_dismissed:${environment.apiUrl}`;
  private dismissal: Dismissal | null = null;
  private subscriptions = new Subscription();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private viewReady = false;
  private layoutFrame?: number;
  private navbarElements: HTMLElement[] = [];
  private navbarResize?: ResizeObserver;
  private navbarStyles?: MutationObserver;
  private clearance = 0;
  private storageChanged = (event: StorageEvent) => {
    if (event.key === this.dismissalKey || event.key === null) {
      this.dismissal = null;
      this.zone.run(() => this.refreshNotice());
    }
  };

  constructor(public auth: AuthService, private hosting: ManagedHostingService, private zone: NgZone, private host: ElementRef<HTMLElement>) {}

  private scheduleLayout = () => {
    if (!this.viewReady || this.layoutFrame !== undefined || (!this.notice && !this.clearance)) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      // Both the web phone toolbar and native shells can fix the navbar.
      // Reserve only the missing space; native safe-area margins may already
      // provide some or all of it. Keep the banner in normal document flow.
      const fixed = this.navbarElements.some(element => getComputedStyle(element).position === 'fixed');
      const bottom = fixed ? Math.max(...this.navbarElements.map(element => element.getBoundingClientRect().bottom)) : 0;
      const documentTop = this.host.nativeElement.getBoundingClientRect().top + window.scrollY;
      const clearance = this.notice && fixed ? Math.max(0, Math.ceil(bottom - documentTop)) : 0;
      if (clearance !== this.clearance) {
        this.clearance = clearance;
        this.host.nativeElement.style.setProperty('--plan-notice-clearance', `${clearance}px`);
      }
    });
  };

  get message() {
    if (!this.notice) return '';
    if (this.auth.isAdmin) {
      return this.notice.kind === 'ending' ? (uiText('managed_notice_banner.your_value0_plan_ends_on_value1_download_a_backup_or_keep_your_pl', { value0: (this.info?.providerName || 'hosting'), value1: (this.formatDate(this.notice.endsAt)) })) : (uiText('managed_notice_banner.value0_couldn_t_take_your_last_payment_update_your_billing_to_kee', { value0: (this.info?.providerName || 'Your hosting provider') }));
    }
    return this.notice.kind === 'ending' ? (uiText('managed_notice_banner.this_server_s_plan_ends_on_value0_save_a_copy_of_your_notes_or_as', { value0: (this.formatDate(this.notice.endsAt)) })) : (uiText('managed_notice_banner.this_server_s_plan_has_a_payment_problem_ask_the_server_s_owner_t'));
  }

  ngOnInit() {
    this.subscriptions.add(this.hosting.info$.subscribe(info => { this.info = info; this.refreshNotice(); }));
    this.subscriptions.add(this.auth.accessChanges$.subscribe(() => this.refreshNotice()));
    window.addEventListener('storage', this.storageChanged);
    void this.hosting.info();
  }

  ngAfterViewInit() {
    this.viewReady = true;
    const navbar = document.querySelector<HTMLElement>('app-navbar');
    const toolbar = navbar?.querySelector<HTMLElement>('.main-container');
    this.navbarElements = [navbar, toolbar].filter((element): element is HTMLElement => !!element);
    if (typeof ResizeObserver !== 'undefined') {
      this.navbarResize = new ResizeObserver(this.scheduleLayout);
      this.navbarElements.forEach(element => this.navbarResize!.observe(element));
    }
    if (typeof MutationObserver !== 'undefined') {
      this.navbarStyles = new MutationObserver(this.scheduleLayout);
      this.navbarElements.forEach(element => this.navbarStyles!.observe(element, { attributes: true, attributeFilter: ['style', 'class'] }));
    }
    window.addEventListener('resize', this.scheduleLayout);
    this.scheduleLayout();
  }

  private noticeKey(notice: ManagedHostingNotice) {
    return JSON.stringify([notice.kind, notice.endsAt, notice.deletesAt]);
  }

  private refreshNotice() {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    const notice = this.info?.managed && !this.auth.isLocal ? this.info.notice : null;
    this.notice = notice;
    this.scheduleLayout();
    if (!notice) return;
    let dismissal = this.dismissal;
    if (!dismissal) {
      try { dismissal = JSON.parse(localStorage.getItem(this.dismissalKey) || 'null'); } catch {}
    }
    if (dismissal?.notice === this.noticeKey(notice) && Number.isFinite(dismissal.until) && dismissal.until > Date.now()) {
      this.notice = null;
      this.expiryTimer = setTimeout(() => this.zone.run(() => this.refreshNotice()), Math.min(DAY_MS, dismissal.until - Date.now()));
    }
  }

  dismiss() {
    if (!this.notice) return;
    this.dismissal = { notice: this.noticeKey(this.notice), until: Date.now() + DAY_MS };
    try { localStorage.setItem(this.dismissalKey, JSON.stringify(this.dismissal)); } catch {}
    this.refreshNotice();
  }

  formatDate(value: string | null) {
    if (!value) return '';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  ngOnDestroy() {
    this.viewReady = false;
    this.subscriptions.unsubscribe();
    window.removeEventListener('storage', this.storageChanged);
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    window.removeEventListener('resize', this.scheduleLayout);
    this.navbarResize?.disconnect();
    this.navbarStyles?.disconnect();
    if (this.layoutFrame !== undefined) cancelAnimationFrame(this.layoutFrame);
  }
}
