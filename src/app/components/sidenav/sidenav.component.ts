import { uiText } from 'src/app/i18n/messages';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { SharedService } from 'src/app/services/shared.service';
import { LabelActionsT } from 'src/app/interfaces/labels';
import { Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';
import { isNativePhonePlatform } from 'src/app/utils/platform';
import { BindersService, BinderSharingInfo } from 'src/app/services/binders.service';
import { ShareUserI } from 'src/app/interfaces/users';

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

  get drawerClosed() {
    return this.usesDrawerSidebar() && !this.isMobileOpen;
  }

  installHelpOpen = false;

  bindersExpanded = true;
  labelsExpanded = true;
  binderBusy = false;
  binderEditError = '';
  labelBusy = false;
  labelEditError = '';
  private readonly sidebarStateKey = 'kept_sidebar_collapsed';
  private subscriptions: Subscription[] = [];
  sharingOpen = false;
  sharingBusy = false;
  sharingSaving = false;
  sharingError = '';
  sharingInfo?: BinderSharingInfo;
  sharingUsers: ShareUserI[] = [];
  sharingSelectedIds: number[] = [];
  private sharingRequest = 0;
  private labelCountsRequest = 0;
  private labelCountsPartition = '';
  private labelNoteCounts?: Record<string,number>;
  private previewRequest = 0;
  private previewPartition = '';
  private sharingPreviews = new Map<string,ShareUserI[]>();
  private sharingOpener?: HTMLElement;
  get binderCount() { return this.Shared.binder.list.length + this.Shared.sharedBinders.length; }

  constructor(public Shared: SharedService, public router: Router, public auth: AuthService, private binders: BindersService) {
    this.Shared.initPwa();
  }

  // ? modal ----------------------------------------------------------
  openModal() {
    this.labelEditError = '';
    this.modalContainer.nativeElement.style.display = 'block';
    void this.refreshLabelCounts();
    document.addEventListener('mousedown', this.mouseDownEvent)
  }
  hideModal() {
    ++this.labelCountsRequest;
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
          const oldName=this.Shared.label.list.find(label=>label.id===id)?.name;
          this.Shared.label.id = id
          await this.Shared.label.db.update({ name: value })
          await this.Shared.label.db.updateAllLabels(value)
          if (oldName && this.labelNoteCounts && Object.hasOwn(this.labelNoteCounts,oldName)) {
            this.labelNoteCounts[value.trim()]=this.labelNoteCounts[oldName];
            if (oldName!==value.trim()) delete this.labelNoteCounts[oldName];
          }
          void this.refreshLabelCounts();
          this.labelError.nativeElement.hidden = true
        });
      }
    }
    return actions
  }

  labelNoteCount(name: string): number | undefined {
    if (this.labelCountsPartition!==this.binders.sync.partition || !this.labelNoteCounts) return undefined;
    return Object.hasOwn(this.labelNoteCounts,name) ? this.labelNoteCounts[name] : 0;
  }

  private async refreshLabelCounts() {
    const request=++this.labelCountsRequest,partition=this.binders.sync.partition;
    if (partition!==this.labelCountsPartition) this.labelNoteCounts=undefined;
    this.labelCountsPartition=partition;
    try {
      const counts=await this.Shared.label.db.noteCounts();
      if (request===this.labelCountsRequest && partition===this.binders.sync.partition) this.labelNoteCounts=counts;
    } catch { /* Keep label editing usable when counts cannot be refreshed. */ }
  }

  onLabelReorderKeydown(event: KeyboardEvent,id: number) {
    if (event.key!=='ArrowUp' && event.key!=='ArrowDown') return;
    event.preventDefault();event.stopPropagation();
    void this.moveLabel(id,event.key==='ArrowUp' ? -1 : 1,event);
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
      this.labelEditError = uiText('sidenav.could_not_save_your_label_changes_please_try_again');
    } finally {
      this.labelBusy = false;
    }
  }

  openBinderModal() {
    this.binderEditError = '';
    this.binderModalContainer.nativeElement.style.display = 'block';
    void this.refreshSharingPreviews();
    document.addEventListener('mousedown', this.binderMouseDownEvent)
  }

  hideBinderModal() {
    ++this.previewRequest;
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
      delete: () => {
        const shared = this.Shared.binder.list.find(binder => binder.name === name)?.memberCount;
        if (shared && !confirm(uiText('binder_sharing.delete_confirm',{name}))) return Promise.resolve();
        return this.changeBinder(async () => {
          await this.Shared.binder.db.delete(name);
          ++this.previewRequest;
          this.sharingPreviews.delete(name.toLowerCase());
        });
      },
      update: (value: string) => value.trim() === name ? Promise.resolve() : this.changeBinder(async () => {
        await this.Shared.binder.db.update(name, value);
        ++this.previewRequest;
        const members=this.sharingPreviews.get(name.toLowerCase());
        if (members) {
          this.sharingPreviews.delete(name.toLowerCase());
          this.sharingPreviews.set(value.trim().toLowerCase(),members);
        } else void this.refreshSharingPreviews();
      })
    }
  }

  binderPreview(name: string) {
    return this.previewPartition===this.binders.sync.partition ? this.sharingPreviews.get(name.toLowerCase()) : undefined;
  }

  private async refreshSharingPreviews() {
    const request=++this.previewRequest,partition=this.binders.sync.partition;
    if (partition!==this.previewPartition) this.sharingPreviews.clear();
    this.previewPartition=partition;
    if (this.auth.isLocal) return;
    try {
      const previews=await this.binders.sharingPreviews();
      if (request===this.previewRequest && partition===this.binders.sync.partition) this.sharingPreviews=previews;
    } catch { /* Sharing can be unavailable while binder editing still works offline. */ }
  }

  onBinderReorderKeydown(event: KeyboardEvent,name: string) {
    if (event.key!=='ArrowUp' && event.key!=='ArrowDown') return;
    event.preventDefault();event.stopPropagation();
    void this.moveBinder(name,event.key==='ArrowUp' ? -1 : 1,event);
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
      this.binderEditError = uiText('sidenav.could_not_save_your_binder_changes_please_try_again');
    } finally {
      this.binderBusy = false;
    }
  }

  toggleBinders() {
    if (!this.binderCount) return;
    this.bindersExpanded = !this.bindersExpanded;
    this.saveSectionExpanded('binders', this.bindersExpanded);
  }

  async openBinderSharing(name: string, receivedId?: number) {
    if (this.auth.isLocal || this.sharingBusy) return;
    const request = ++this.sharingRequest;
    this.sharingOpener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.sharingOpen = true;this.sharingBusy = true;this.sharingError = '';this.sharingInfo = undefined;
    setTimeout(() => document.querySelector<HTMLElement>('.binder-sharing-dialog')?.focus(),0);
    try {
      const info = receivedId === undefined ? await this.binders.sharingForName(name) : await this.binders.sharing(receivedId);
      const users = info.canManage ? await this.Shared.note.db.listShareUsers() : info.members;
      if (request !== this.sharingRequest) return;
      this.sharingInfo = info;this.sharingUsers = users;this.sharingSelectedIds = info.members.map(user => user.id);
    } catch (error: any) {
      if (request !== this.sharingRequest) return;
      this.sharingError = error?.status === 404 ? uiText('binder_sharing.update_server') : error?.error?.error || uiText('binder_sharing.load_failed');
    } finally { if (request === this.sharingRequest) this.sharingBusy = false; }
  }

  closeBinderSharing() {
    if (this.sharingSaving) return;
    ++this.sharingRequest;this.sharingOpen = false;this.sharingBusy = false;
    this.sharingOpener?.focus();
  }
  onSharingKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.stopPropagation();this.closeBinderSharing(); }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLElement;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));
    const first = controls[0],last = controls[controls.length-1];
    if ((event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();(event.shiftKey ? last : first)?.focus();
    }
  }
  toggleBinderMember(id: number) {
    if (this.sharingBusy || !this.sharingInfo?.canManage) return;
    this.sharingSelectedIds = this.sharingSelectedIds.includes(id) ? this.sharingSelectedIds.filter(value => value !== id) : [...this.sharingSelectedIds,id];
  }
  async saveBinderSharing() {
    if (this.sharingBusy || !this.sharingInfo?.canManage) return;
    this.sharingBusy = true;this.sharingSaving = true;this.sharingError = '';
    try {
      this.sharingInfo = await this.binders.share(this.sharingInfo.binder.id,this.sharingSelectedIds);
      ++this.previewRequest;
      this.previewPartition=this.binders.sync.partition;
      this.sharingPreviews.set(this.sharingInfo.binder.name.toLowerCase(),this.sharingInfo.members);
      this.sharingOpen = false;
    } catch (error: any) { this.sharingError = error?.error?.error || uiText('binder_sharing.save_failed'); }
    finally { this.sharingBusy = false;this.sharingSaving = false; }
  }
  async leaveSharedBinder() {
    if (this.sharingBusy || !this.sharingInfo || this.sharingInfo.canManage) return;
    if (!confirm(uiText('binder_sharing.leave_confirm',{name:this.sharingInfo.binder.name}))) return;
    this.sharingBusy = true;this.sharingSaving = true;this.sharingError = '';
    try {
      await this.binders.leave(this.sharingInfo.binder.id);this.sharingOpen = false;
      if (this.router.url.startsWith(`/shared-binder/${this.sharingInfo.binder.id}`)) await this.router.navigateByUrl('/');
    } catch (error: any) { this.sharingError = error?.error?.error || uiText('binder_sharing.save_failed'); }
    finally { this.sharingBusy = false;this.sharingSaving = false; }
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
      // Phone drawers always start closed. Only remember the docked sidebar's
      // deliberate expanded/collapsed choice on this device.
      if (!this.usesDrawerSidebar()) {
        try { localStorage.setItem(this.sidebarStateKey, String(collapsed)); } catch {}
      }
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
    if (sidebar) {
      if (this.usesDrawerSidebar()) sidebar.classList.add('close');
      else {
        try {
          const saved = localStorage.getItem(this.sidebarStateKey);
          if (saved === 'true' || saved === 'false') sidebar.classList.toggle('close', saved === 'true');
        } catch {}
      }
    }
    const collapsed = !!sidebar?.classList.contains('close');
    this.Shared.sideBarCollapsed.next(collapsed);
    this.isMobileOpen = !collapsed && this.usesDrawerSidebar();
  }

  ngOnDestroy() {
    ++this.sharingRequest;
    ++this.previewRequest;
    ++this.labelCountsRequest;
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
