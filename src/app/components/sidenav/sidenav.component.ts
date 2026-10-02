import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { SharedService } from 'src/app/services/shared.service';
import { LabelActionsT } from 'src/app/interfaces/labels';
import { Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';
import { isNativePhonePlatform } from 'src/app/utils/platform';

@Component({
    selector: 'app-sidenav',
    templateUrl: './sidenav.component.html',
    styleUrls: ['./sidenav.component.scss'],
    standalone: false
})
export class NavComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild("modalContainer ") modalContainer !: ElementRef<HTMLInputElement>
  @ViewChild("modal") modal !: ElementRef<HTMLInputElement>
  @ViewChild("labelInput") labelInput !: ElementRef<HTMLInputElement>
  @ViewChild("labelError") labelError !: ElementRef<HTMLInputElement>
  @ViewChild("binderModalContainer") binderModalContainer !: ElementRef<HTMLInputElement>
  @ViewChild("binderModal") binderModal !: ElementRef<HTMLInputElement>
  @ViewChild("binderInput") binderInput !: ElementRef<HTMLInputElement>
  @ViewChild("binderError") binderError !: ElementRef<HTMLInputElement>
  @ViewChild('labelsScroll') labelsScroll?: ElementRef<HTMLDivElement>

  isMobileOpen = false;
  get nativePhoneDrawer() {
    return isNativePhonePlatform();
  }

  installHelpOpen = false;

  // Visual cues that the labels region is scrollable.
  canScrollUp = false;
  canScrollDown = false;
  private labelsResizeObserver?: ResizeObserver;
  private labelsMutationObserver?: MutationObserver;
  private subscriptions: Subscription[] = [];

  constructor(public Shared: SharedService, public router: Router, public auth: AuthService) {
    this.Shared.initPwa();
  }

  // ? modal ----------------------------------------------------------
  openModal() {
    this.modalContainer.nativeElement.style.display = 'block';
    document.addEventListener('mousedown', this.mouseDownEvent)
  }
  hideModal() {
    this.modalContainer.nativeElement.style.display = 'none'
    document.removeEventListener('mousedown', this.mouseDownEvent)
  }
  mouseDownEvent = (event: Event) => {
    let modalEl = this.modal.nativeElement
    if (!(modalEl as any).contains(event.target)) {
      this.hideModal()
    }
  }

  // ? labels ----------------------------------------------------

  addLabel(el: HTMLInputElement) {
    if (!el) return
    this.Shared.label.db.add({ name: el.value })
      .then(() => { this.labelError.nativeElement.hidden = true; el.value = ''; el.focus() })
      .catch(x => { if (x.status === 409) this.labelError.nativeElement.hidden = false; el.focus() })
  }

  editLabel(id: number) {
    this.Shared.label.id = id
    let actions: LabelActionsT = {
      delete: async () => {
        try {
          await this.Shared.label.db.delete()
          await this.Shared.label.db.updateAllLabels('')
          this.labelError.nativeElement.hidden = true
        } catch {
          this.labelError.nativeElement.hidden = false
        }
      },
      update: async (value: string) => {
        try {
          await this.Shared.label.db.update({ name: value })
          await this.Shared.label.db.updateAllLabels(value)
          this.labelError.nativeElement.hidden = true
        } catch {
          this.labelError.nativeElement.hidden = false
        }
      }
    }
    return actions
  }

  openBinderModal() {
    this.binderModalContainer.nativeElement.style.display = 'block';
    document.addEventListener('mousedown', this.binderMouseDownEvent)
  }

  hideBinderModal() {
    this.binderModalContainer.nativeElement.style.display = 'none'
    document.removeEventListener('mousedown', this.binderMouseDownEvent)
  }

  binderMouseDownEvent = (event: Event) => {
    let modalEl = this.binderModal.nativeElement
    if (!(modalEl as any).contains(event.target)) {
      this.hideBinderModal()
    }
  }

  addBinder(el: HTMLInputElement) {
    if (!el) return
    const name = el.value.trim()
    if (!name) return
    const exists = this.Shared.binder.list.some(binder => binder.name.toLowerCase() === name.toLowerCase())
    if (exists) {
      this.binderError.nativeElement.hidden = false
      el.focus()
      return
    }
    this.Shared.binder.db.add(name)
      .then(() => { this.binderError.nativeElement.hidden = true; el.value = ''; el.focus() })
      .catch(() => { this.binderError.nativeElement.hidden = false; el.focus() })
  }

  editBinder(name: string) {
    return {
      delete: () => this.Shared.binder.db.delete(name),
      update: (value: string) => this.Shared.binder.db.update(name, value)
    }
  }

  compactLabel(name: string) {
    const words = String(name || '')
      .trim()
      .replace(/[^a-z0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return '#';
    if (words.length > 1) return words.slice(0, 3).map(word => word[0]).join('').toUpperCase();
    return words[0].slice(0, 3).toUpperCase();
  }


  collapseSideBar() {
    const sidebar = document.querySelector('[sideBar]');
    if (sidebar) {
      const collapsed = sidebar.classList.toggle('close');
      this.Shared.sideBarCollapsed.next(collapsed);
      this.isMobileOpen = !collapsed && this.usesDrawerSidebar();
    }
  }

  closeSideBarIfOpen() {
    if (!this.usesDrawerSidebar()) return
    const sidebar = document.querySelector('[sideBar]')
    if (sidebar && !sidebar.classList.contains('close')) {
      sidebar.classList.add('close')
      this.isMobileOpen = false
      this.Shared.sideBarCollapsed.next(true)
    }
  }

  onNavItemClick() {
    if (!this.usesDrawerSidebar()) return
    const sidebar = document.querySelector('[sideBar]')
    if (sidebar && !sidebar.classList.contains('close')) {
      sidebar.classList.add('close')
      this.isMobileOpen = false;
      this.Shared.sideBarCollapsed.next(true)
    }
  }

  toggleTheme() {
    const nextTheme = this.auth.currentUser?.theme === 'light' ? 'dark' : 'light'
    this.auth.updateTheme(nextTheme)
    this.onNavItemClick()
  }

  async logout() {
    await this.auth.logout()
    this.router.navigateByUrl('/login')
    this.onNavItemClick()
  }


  openInstallPwa() {
    if (this.Shared.deferredInstallPrompt) {
      const promptEvent = this.Shared.deferredInstallPrompt;
      this.Shared.deferredInstallPrompt = undefined;
      promptEvent.prompt();
      promptEvent.userChoice.finally(() => this.Shared.updateInstallVisibility());
      return;
    }
    this.installHelpOpen = true;
  }

  ngOnInit(): void {
    this.subscriptions.push(
      this.Shared.closeSideBar.subscribe(x => { if (x) this.collapseSideBar() }),
      this.Shared.closeSideBarIfOpen.subscribe(x => { if (x) this.closeSideBarIfOpen() })
    );
    const sidebar = document.querySelector('[sideBar]');
    if (this.usesDrawerSidebar() && sidebar && !sidebar.classList.contains('close')) {
      sidebar.classList.add('close');
    }
    const collapsed = !!sidebar?.classList.contains('close');
    this.Shared.sideBarCollapsed.next(collapsed);
    this.isMobileOpen = !collapsed && this.usesDrawerSidebar();
  }

  ngAfterViewInit() {
    const el = this.labelsScroll?.nativeElement;
    if (!el) return;
    this.updateLabelsOverflowState();
    if (typeof ResizeObserver !== 'undefined') {
      this.labelsResizeObserver = new ResizeObserver(() => this.updateLabelsOverflowState());
      this.labelsResizeObserver.observe(el);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.labelsMutationObserver = new MutationObserver(() => this.updateLabelsOverflowState());
      this.labelsMutationObserver.observe(el, { childList: true });
    }
  }

  ngOnDestroy() {
    this.labelsResizeObserver?.disconnect();
    this.labelsMutationObserver?.disconnect();
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  onLabelsScroll() {
    this.updateLabelsOverflowState();
  }

  @HostListener('window:resize')
  onWindowResizeForOverflow() {
    this.updateLabelsOverflowState();
  }

  private updateLabelsOverflowState() {
    const el = this.labelsScroll?.nativeElement;
    if (!el) {
      this.canScrollUp = false;
      this.canScrollDown = false;
      return;
    }
    const max = el.scrollHeight - el.clientHeight;
    // 2px tolerance to avoid sub-pixel flicker.
    this.canScrollUp = el.scrollTop > 2;
    this.canScrollDown = el.scrollTop < max - 2;
  }

  private usesDrawerSidebar() {
    return this.nativePhoneDrawer || window.innerWidth <= 599;
  }
}
