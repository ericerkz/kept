import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
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
export class NavComponent implements OnInit, OnDestroy {
  @ViewChild("modalContainer ") modalContainer !: ElementRef<HTMLInputElement>
  @ViewChild("modal") modal !: ElementRef<HTMLInputElement>
  @ViewChild("labelInput") labelInput !: ElementRef<HTMLInputElement>
  @ViewChild("labelError") labelError !: ElementRef<HTMLInputElement>
  @ViewChild("binderModalContainer") binderModalContainer !: ElementRef<HTMLInputElement>
  @ViewChild("binderModal") binderModal !: ElementRef<HTMLInputElement>
  @ViewChild("binderInput") binderInput !: ElementRef<HTMLInputElement>
  @ViewChild("binderError") binderError !: ElementRef<HTMLInputElement>

  isMobileOpen = false;
  get nativePhoneDrawer() {
    return isNativePhonePlatform();
  }

  installHelpOpen = false;

  bindersExpanded = true;
  labelsExpanded = true;
  binderBusy = false;
  binderEditError = '';
  labelBusy = false;
  labelEditError = '';
  private subscriptions: Subscription[] = [];

  constructor(public Shared: SharedService, public router: Router, public auth: AuthService) {
    this.Shared.initPwa();
  }

  // ? modal ----------------------------------------------------------
  openModal() {
    this.labelEditError = '';
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
    if (!el || this.labelBusy) return
    this.Shared.label.db.add({ name: el.value })
      .then(() => { this.labelError.nativeElement.hidden = true; el.value = ''; el.focus() })
      .catch(x => { if (x.status === 409) this.labelError.nativeElement.hidden = false; el.focus() })
  }

  editLabel(id: number) {
    let actions: LabelActionsT = {
      delete: () => this.changeLabel(async () => {
        this.Shared.label.id = id
        await this.Shared.label.db.delete()
        await this.Shared.label.db.updateAllLabels('')
        this.labelError.nativeElement.hidden = true
      }),
      update: async (value: string) => {
        if (value.trim() === this.Shared.label.list.find(label => label.id === id)?.name) return;
        await this.changeLabel(async () => {
          this.Shared.label.id = id
          await this.Shared.label.db.update({ name: value })
          await this.Shared.label.db.updateAllLabels(value)
          this.labelError.nativeElement.hidden = true
        });
      }
    }
    return actions
  }

  async moveLabel(id: number, direction: -1 | 1, event: Event) {
    if (this.labelBusy) return;
    const button = event.currentTarget as HTMLButtonElement;
    const labels = [...this.Shared.label.list];
    const index = labels.findIndex(label => label.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= labels.length) return;
    [labels[index], labels[next]] = [labels[next], labels[index]];
    await this.changeLabel(() => this.Shared.label.db.reorder(labels));
    setTimeout(() => {
      if (!button.isConnected) return;
      const target = button.disabled ? button.closest('.label-edit-row')?.querySelector<HTMLButtonElement>('button:not(:disabled)') : button;
      target?.focus();
    }, 0);
  }

  reorderLabels(names: string[]) {
    const labels = names.map(name => this.Shared.label.list.find(label => label.name === name));
    if (labels.some(label => !label)) return;
    return this.changeLabel(() => this.Shared.label.db.reorder(labels as typeof this.Shared.label.list));
  }

  reorderBinders(names: string[]) {
    return this.changeBinder(() => this.Shared.binder.db.reorder(names));
  }

  private async changeLabel(change: () => Promise<unknown>) {
    if (this.labelBusy) return;
    this.labelBusy = true;
    this.labelEditError = '';
    try {
      await change();
    } catch {
      this.labelEditError = 'Could not save your label changes. Please try again.';
    } finally {
      this.labelBusy = false;
    }
  }

  openBinderModal() {
    this.binderEditError = '';
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
      delete: () => this.changeBinder(() => this.Shared.binder.db.delete(name)),
      update: (value: string) => value.trim() === name ? Promise.resolve() : this.changeBinder(() => this.Shared.binder.db.update(name, value))
    }
  }

  async moveBinder(name: string, direction: -1 | 1, event: Event) {
    if (this.binderBusy) return;
    const button = event.currentTarget as HTMLButtonElement;
    const names = this.Shared.binder.list.map(binder => binder.name);
    const index = names.indexOf(name);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= names.length) return;
    [names[index], names[next]] = [names[next], names[index]];
    await this.changeBinder(() => this.Shared.binder.db.reorder(names));
    // Disabling controls during the write drops keyboard focus in some browsers.
    setTimeout(() => {
      if (!button.isConnected) return;
      const target = button.disabled ? button.closest('.binder-edit-row')?.querySelector<HTMLButtonElement>('button:not(:disabled)') : button;
      target?.focus();
    }, 0);
  }

  private async changeBinder(change: () => Promise<unknown>) {
    if (this.binderBusy) return;
    this.binderBusy = true;
    this.binderEditError = '';
    try {
      await change();
    } catch {
      this.binderEditError = 'Could not save your binder changes. Please try again.';
    } finally {
      this.binderBusy = false;
    }
  }

  toggleBinders() {
    if (!this.Shared.binder.list.length) return;
    this.bindersExpanded = !this.bindersExpanded;
    this.saveSectionExpanded('binders', this.bindersExpanded);
  }

  toggleLabels() {
    if (!this.Shared.label.list.length) return;
    this.labelsExpanded = !this.labelsExpanded;
    this.saveSectionExpanded('labels', this.labelsExpanded);
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
    const nextTheme = this.auth.effectiveTheme === 'light' ? 'dark' : 'light'
    this.auth.updateTheme(nextTheme)
    this.onNavItemClick()
  }

  async logout() {
    try {
      if (await this.auth.logout()) return
    } catch (error) {
      const text = error instanceof Error && error.name === 'KeptServerResetError' ? error.message : 'Connect to the server to sign out.'
      ;(window as any).Snackbar?.show({ text, duration: 4000 })
      return
    }
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
    this.bindersExpanded = this.readSectionExpanded('binders');
    this.labelsExpanded = this.readSectionExpanded('labels');
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

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  private sectionStorageKey(section: 'binders' | 'labels') {
    return `kept_sidebar_${section}_expanded:${this.auth.currentUser?.id || 'anon'}`;
  }

  private readSectionExpanded(section: 'binders' | 'labels') {
    try { return localStorage.getItem(this.sectionStorageKey(section)) !== 'false'; }
    catch { return true; }
  }

  private saveSectionExpanded(section: 'binders' | 'labels', expanded: boolean) {
    try { localStorage.setItem(this.sectionStorageKey(section), String(expanded)); }
    catch { /* Sidebar remains usable when storage is blocked. */ }
  }

  private usesDrawerSidebar() {
    return this.nativePhoneDrawer || window.innerWidth <= 599;
  }
}
