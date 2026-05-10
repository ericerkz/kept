import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { SharedService } from 'src/app/services/shared.service';
import { LabelActionsT } from 'src/app/interfaces/labels';
import { Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';

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
  @ViewChild('labelsScroll') labelsScroll?: ElementRef<HTMLDivElement>

  isMobileOpen = false;

  installHelpOpen = false;

  // Visual cues that the labels region is scrollable.
  canScrollUp = false;
  canScrollDown = false;
  private labelsResizeObserver?: ResizeObserver;
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
      delete: () => {
        this.Shared.label.db.delete()
        this.Shared.label.db.updateAllLabels('')
      },
      update: (value: string) => {
        this.Shared.label.db.update({ name: value })
        this.Shared.label.db.updateAllLabels(value)
      }
    }
    return actions
  }


  collapseSideBar() {
    const sidebar = document.querySelector('[sideBar]');
    if (sidebar) {
      sidebar.classList.toggle('close');
      this.isMobileOpen = !sidebar.classList.contains('close') && window.innerWidth <= 599;
    }
  }

  onNavItemClick() {
    if (window.innerWidth > 599) return
    const sidebar = document.querySelector('[sideBar]')
    if (sidebar && !sidebar.classList.contains('close')) {
      sidebar.classList.add('close')
      this.isMobileOpen = false;
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
      this.Shared.closeSideBar.subscribe(x => { if (x) this.collapseSideBar() })
    );
    if (window.innerWidth <= 600) {
      const sidebar = document.querySelector('[sideBar]');
      if (sidebar && !sidebar.classList.contains('close')) {
        sidebar.classList.add('close');
      }
      this.isMobileOpen = false;
    }
  }

  ngAfterViewInit() {
    const el = this.labelsScroll?.nativeElement;
    if (!el) return;
    this.updateLabelsOverflowState();
    if (typeof ResizeObserver !== 'undefined') {
      this.labelsResizeObserver = new ResizeObserver(() => this.updateLabelsOverflowState());
      this.labelsResizeObserver.observe(el);
    }
  }

  ngOnDestroy() {
    this.labelsResizeObserver?.disconnect();
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
}
