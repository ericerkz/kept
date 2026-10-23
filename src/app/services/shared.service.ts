import { Injectable, NgZone } from '@angular/core';
import { NoteI, NoteModelI, UpdateKeyI } from '../interfaces/notes';
import { NotesService } from './notes.service';
import { BehaviorSubject, Subject } from 'rxjs';
import { LabelsService } from './labels.service';
import { LabelI, LabelModelI } from '../interfaces/labels';
import { createDemoNotes, demoWelcomeText } from '../utils/demo-notes';
import { AuthService } from './auth.service';
import { ReminderService } from './reminder.service';
import { createPopper, type Placement } from '@popperjs/core';
import { BindersService } from './binders.service';
import { environment } from 'src/environments/environment';
declare var Snackbar: any
export type WidgetCreateType = 'plain' | 'checklist' | 'drawing'
export type WidgetCreateRequest = { requestId: string; type: WidgetCreateType }
@Injectable({
  providedIn: 'root'
})
export class SharedService {
  private tooltipOutsideListeners = new WeakMap<HTMLDivElement, (event: Event) => void>();
  private readonly binderStorageKey = 'kept_binders_v1';
  private readonly noteViewTypeStorageKey = 'kept_note_view_type';

  // PWA State
  deferredInstallPrompt?: any;
  isIos = false;
  isMobile = false;
  isStandalone = false;
  showInstallButton = new BehaviorSubject<boolean>(false);

  private creatingExamples = false;
  private serverLabels: LabelI[] = [];

  constructor(
    private Notes: NotesService,
    private Labels: LabelsService,
    private auth: AuthService,
    private reminders: ReminderService,
    private ngZone: NgZone,
    private binders: BindersService
  ) {
    // Wire the result subscriptions once. Loads happen in response to
    // currentUser$ — that way a fresh login (or a session that arrives
    // after async auth bootstrap, common on iOS Safari/PWA) triggers a
    // load. Without this, the constructor-time load runs before the
    // session is ready and the page stays blank until manual refresh.
    this.Labels.labelsList$.subscribe({
      next: (result: LabelI[]) => {
        this.serverLabels = result || [];
        this.refreshLabelList();
      },
      error: error => console.error(error)
    })
    this.Notes.notesList$.subscribe({
      next: (result: NoteI[] | null) => {
        if (result === null) return;
        this.ngZone.run(() => {
          const ordered = [...result]
          this.note.pinned = ordered.filter(x => x.pinned === true)
          this.note.unpinned = ordered.filter(x => x.pinned === false)
          this.note.all = ordered
          this.refreshLabelList();
          this.refreshBinderList();
        })
      },
      error: error => console.error(error)
    })

    this.binders.items$.subscribe(() => this.refreshBinderList());
    this.auth.accessChanges$.subscribe(async user => {
      if (this.auth.isLocal) {
        try {
          await this.auth.workspace.seedDemoNotes();
          if (!this.auth.isLocal) return;
          await this.Notes.load(); await this.Labels.load(); await this.binders.load();
        } catch (error) { console.error('Could not load the device library', error); }
        return;
      }
      if (user) {
        // If this user has never had demos seeded server-side, do that
        // *before* the first notes load. That way the user lands on a
        // populated grid on first login — they shouldn't have to refresh
        // or sign out/in to see the starter content.
        const needsDemos = !user.demoNotesCreatedAt
        if (needsDemos && navigator.onLine) {
          await this.createExampleNotes()
        }
        this.Notes.load().catch(console.error)
        if (navigator.onLine) this.Labels.load().catch(console.error)
      } else {
        // Logout: clear the in-memory mirror so the next user doesn't
        // briefly see the previous account's notes.
        this.note.pinned = []
        this.note.unpinned = []
        this.note.all = []
        this.serverLabels = []
        this.label.list = []
        this.binder.list = []
      }
    })
  }

  closeSideBar = new Subject<boolean>()
  closeSideBarIfOpen = new Subject<boolean>()
  sideBarCollapsed = new BehaviorSubject<boolean>(false)
  openMobileComposer = new Subject<boolean>()
  widgetCreateRequested = new Subject<WidgetCreateRequest>()
  widgetComposerOpened = new Subject<WidgetCreateRequest>()
  closeMobileComposer = new Subject<boolean>()
  openSelectedReminder = new Subject<void>()
  saveNote = new Subject<boolean>()
  closeModal = new Subject<boolean>()
  noteViewType = new BehaviorSubject<'list' | 'grid'>(this.initialNoteViewType())
  selectedNoteIds = new BehaviorSubject<number[]>([])
  searchScope = new BehaviorSubject<'all' | 'current'>(this.initialSearchScope())
  searchQuery = ''
  // Keep an autosaved inline draft out of this tab's overview until closed.
  composerDraftSyncId?: string

  initPwa() {
    const ua = navigator.userAgent;
    this.isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    this.isMobile = this.isIos || /android|mobile/i.test(ua);
    this.isStandalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
    this.updateInstallVisibility();

    window.addEventListener('beforeinstallprompt', (event: Event) => {
      event.preventDefault();
      this.deferredInstallPrompt = event;
      this.ngZone.run(() => this.updateInstallVisibility());
    });

    window.addEventListener('appinstalled', () => {
      this.deferredInstallPrompt = undefined;
      this.isStandalone = true;
      this.ngZone.run(() => this.updateInstallVisibility());
    });
  }

  private readonly installFabDismissedKey = 'gk_install_fab_dismissed';

  updateInstallVisibility() {
    this.showInstallButton.next(this.isMobile && !this.isStandalone && (this.isIos || !!this.deferredInstallPrompt));
  }

  isInstallFabDismissed(): boolean {
    try { return localStorage.getItem(this.installFabDismissedKey) === '1'; } catch { return false; }
  }

  dismissInstallFab() {
    try { localStorage.setItem(this.installFabDismissedKey, '1'); } catch {}
    // Re-emit so subscribers can hide the FAB.
    this.showInstallButton.next(this.showInstallButton.value);
  }

  setSearchQuery(query: string) {
    this.searchQuery = query
    this.Notes.setSearchQuery(query)
  }

  setSearchScope(scope: 'all' | 'current') {
    this.searchScope.next(scope)
    try { localStorage.setItem('kept_search_scope', scope); } catch {}
  }

  setNoteViewType(type: 'list' | 'grid') {
    this.noteViewType.next(type)
    try { localStorage.setItem(this.noteViewTypeStorageKey, type); } catch {}
  }

  toggleNoteViewType() {
    this.setNoteViewType(this.noteViewType.value === 'grid' ? 'list' : 'grid')
  }

  private initialNoteViewType(): 'list' | 'grid' {
    try {
      return localStorage.getItem(this.noteViewTypeStorageKey) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  }

  private initialSearchScope(): 'all' | 'current' {
    try {
      return localStorage.getItem('kept_search_scope') === 'current' ? 'current' : 'all'
    } catch {
      return 'all'
    }
  }

  async refreshData() {
    await Promise.all([
      this.Notes.load(),
      this.Labels.load(),
      this.reminders.load()
    ])
  }

  toggleNoteSelection(noteId: number) {
    const selected = this.selectedNoteIds.value
    this.selectedNoteIds.next(selected.includes(noteId) ? selected.filter(id => id !== noteId) : [...selected, noteId])
  }

  clearNoteSelection() {
    this.selectedNoteIds.next([])
  }

  private refreshLabelList() {
    const labels: LabelI[] = [];
    const seen = new Set<string>();

    for (const label of this.serverLabels) {
      this.addLabelIfMissing(labels, seen, label);
    }

    const derivedLabels = (this.note.all || [])
      .flatMap(note => note.labels || [])
      .filter(label => label?.added === true);

    for (const label of derivedLabels) {
      this.addLabelIfMissing(labels, seen, label);
    }

    this.label.list = labels.sort((a, b) => this.compareLabels(a, b));
  }

  private addLabelIfMissing(target: LabelI[], seen: Set<string>, label?: LabelI) {
    const name = String(label?.name || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    target.push({ ...label, name });
  }

  private compareLabels(a: LabelI, b: LabelI) {
    const byName = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    return byName || Number(a.id || 0) - Number(b.id || 0);
  }

  private binderStoragePartition() {
    if (this.auth.isLocal) return `${this.binderStorageKey}:local:${this.auth.workspace.local?.id}`;
    const server = environment.apiUrl || location.origin;
    const userId = this.auth.currentUser?.id || 'anon';
    return `${this.binderStorageKey}:${server}:${userId}`;
  }

  private storedBinders(): string[] {
    try {
      const raw = localStorage.getItem(this.binderStoragePartition());
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  private saveStoredBinders(names: string[]) {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const name of names.map(item => String(item || '').trim()).filter(Boolean)) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(name);
    }
    try { localStorage.setItem(this.binderStoragePartition(), JSON.stringify(unique)); } catch {}
  }

  refreshBinderList() {
    const names = [
      ...(this.binders.sync.writesLocally ? this.binders.items$.value.map(item => item.name) : this.storedBinders()),
      ...(this.note.all || []).map(note => note.binder || '').filter(Boolean)
    ];
    const unique: { name: string }[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const clean = String(name || '').trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ name: clean });
    }
    unique.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    this.binder.list = unique;
  }

  isNoteSelected(noteId?: number) {
    return !!noteId && this.selectedNoteIds.value.includes(noteId)
  }

  async bulkUpdateSelected(object: UpdateKeyI) {
    for (const noteId of this.selectedNoteIds.value) {
      await this.Notes.updateKey(object, noteId)
    }
  }

  async bulkCloneSelected() {
    for (const noteId of this.selectedNoteIds.value) {
      await this.Notes.clone(noteId)
    }
    this.clearNoteSelection()
  }

  async bulkTrashSelected() {
    const selected = this.note.all.filter(note => note.id && this.selectedNoteIds.value.includes(note.id))
    const me = this.auth.currentUser?.id
    let leftSharedCount = 0
    for (const note of selected) {
      if (note.ownerUserId && me && note.ownerUserId !== me) {
        await this.Notes.delete(note.id!)
        leftSharedCount++
      } else {
        await this.Notes.updateKey({ trashed: true, archived: false }, note.id!)
      }
    }
    this.clearNoteSelection()
    if (leftSharedCount) {
      Snackbar.show({
        pos: 'bottom-left',
        text: leftSharedCount === 1 ? 'Shared note removed' : `${leftSharedCount} shared notes removed`,
        duration: 3000
      })
    }
  }

  async bulkTogglePinSelected() {
    const selected = this.note.all.filter(note => note.id && this.selectedNoteIds.value.includes(note.id))
    const shouldPin = selected.some(note => !note.pinned)
    await this.bulkUpdateSelected({ pinned: shouldPin })
  }

  async bulkArchiveSelected() {
    await this.bulkUpdateSelected({ archived: true, trashed: false })
    this.clearNoteSelection()
  }

  async bulkApplyLabel(label: LabelI) {
    const selected = this.note.all.filter(note => note.id && this.selectedNoteIds.value.includes(note.id))
    const shouldAdd = selected.some(note => !note.labels.some(noteLabel => noteLabel.id === label.id && noteLabel.added))

    for (const note of selected) {
      let labels = [...note.labels]
      const existing = labels.find(noteLabel => noteLabel.id === label.id)
      if (shouldAdd) {
        if (existing) existing.added = true
        else labels = [...labels, { ...label, added: true }]
      } else {
        labels = labels.filter(noteLabel => noteLabel.id !== label.id)
      }
      await this.Notes.updateKey({ labels }, note.id!)
    }
  }

  async bulkApplyBinder(name: string) {
    const binder = String(name || '').trim();
    if (binder) await this.binder.db.add(binder);
    const selected = this.note.all.filter(note => note.id && this.selectedNoteIds.value.includes(note.id));
    for (const note of selected) {
      await this.Notes.updateKey({ binder }, note.id!);
    }
  }

  async bulkMergeSelected(orderedIds: number[]) {
    if (!orderedIds || orderedIds.length < 2) return null
    const newNoteId = await this.Notes.merge(orderedIds)
    this.clearNoteSelection()
    return newNoteId
  }

  // ? note -------------------------------------------------

  note: NoteModelI = {
    id: -1,
    pinned: [],
    unpinned: [],
    all: [],
    db: {
      add: (data: NoteI) => this.Notes.add(data),
      update: (data: NoteI) => this.Notes.update(data, this.note.id),
      updateKey: (data: UpdateKeyI) => this.Notes.updateKey(data, this.note.id),
      updateAllLabels: (labelId: number, labelValue: string) => this.Notes.updateAllLabels(labelId, labelValue),
      uploadImage: (file: File) => this.Notes.uploadImage(file),
      uploadAttachment: (noteId: number, file: File) => this.Notes.uploadAttachment(noteId, file),
      deleteAttachment: (noteId: number, attachmentId: number) => this.Notes.deleteAttachment(noteId, attachmentId),
      downloadAttachment: (attachment) => this.Notes.downloadAttachment(attachment),
      get: () => this.Notes.get(this.note.id),
      listShareUsers: () => this.Notes.listShareUsers(),
      getCollaborators: () => this.Notes.getCollaborators(this.note.id),
      updateCollaborators: (userIds: number[]) => this.Notes.updateCollaborators(this.note.id, userIds),
      reorder: (ids: number[]) => this.Notes.reorder(ids),
      clone: () => this.Notes.clone(this.note.id),
      delete: () => this.Notes.delete(this.note.id),
      trash: async () => {
        const note = this.note.all.find(n => n.id === this.note.id)
        if (note?.isDemo) {
          const otherDemoNotes = this.note.all.filter(n => n.isDemo && n.id !== this.note.id)
          if (otherDemoNotes.length > 0) {
            if (confirm('Would you like to delete the rest of the demo notes, too?')) {
              const demoNotes = this.note.all.filter(n => n.isDemo)
              for (const dn of demoNotes) {
                await this.Notes.updateKey({ trashed: true, archived: false }, dn.id!)
              }
              this.snackBar({ action: 'trashed all demo notes', opposite: 'restored' }, { trashed: false }, this.note.id)
              return
            }
          }
        }
        await this.note.db.updateKey({ trashed: true, archived: false })
        this.snackBar({ action: 'trashed', opposite: 'restored' }, { trashed: false }, this.note.id)
      },
    },

  }

  private async createExampleNotes() {
    if (this.creatingExamples || !this.auth.currentUser) return;
    this.creatingExamples = true;
    // Mark before creating so re-entrant loads cannot seed duplicates.
    try { await this.auth.markDemoNotesCreated(); } catch {}
    try {
      let label: LabelI = { name: 'Sweet Thoughts' };
      try { label.id = await this.Labels.add(label); } catch {}
      for (const [index, note] of createDemoNotes(label).entries()) {
        const noteId = await this.Notes.add(note);
        if (!noteId || noteId === -1) continue;
        if (index === 5) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(9, 0, 0, 0);
          await this.reminders.create({
            noteId, dueAtUtc: tomorrow.toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            title: note.noteTitle,
            body: 'Kept will handle the whole "remembering-things" stuff with push notifications across all devices.'
          });
        }
        if (index === 6) {
          try {
            await this.Notes.uploadAttachment(noteId, new Blob([demoWelcomeText], { type: 'text/plain' }), 'welcome.txt');
          } catch (error) { console.warn('Could not attach demo welcome.txt', error); }
        }
      }
    } catch (error) {
      console.error('Failed to create example notes', error);
    } finally {
      this.creatingExamples = false;
    }
  }

  // ? labell -------------------------------------------------

  label: LabelModelI = {
    id: -1,
    list: [],
    db: {
      add: async (data: LabelI) => this.Labels.add(data),
      update: (data: LabelI) => this.Labels.update(data, this.label.id),
      delete: () => this.Labels.delete(this.label.id),
      updateAllLabels: (value: any) => this.note.db.updateAllLabels(this.label.id, value),
    }
  }

  binder = {
    list: [] as { name: string }[],
    db: {
      add: async (name: string) => {
        if (this.binders.sync.writesLocally) return this.binders.save(name);
        const clean = String(name || '').trim();
        if (!clean) return;
        const names = this.storedBinders();
        if (!names.some(item => item.toLowerCase() === clean.toLowerCase())) {
          this.saveStoredBinders([...names, clean]);
        }
        this.refreshBinderList();
      },
      update: async (oldName: string, newName: string) => {
        if (this.binders.sync.writesLocally) return this.binders.save(newName, oldName);
        const oldClean = String(oldName || '').trim();
        const newClean = String(newName || '').trim();
        if (!oldClean || !newClean) return;
        const names = this.storedBinders().map(item => item.toLowerCase() === oldClean.toLowerCase() ? newClean : item);
        this.saveStoredBinders(names);
        for (const note of this.note.all.filter(note => (note.binder || '').toLowerCase() === oldClean.toLowerCase())) {
          if (note.id) await this.Notes.updateKey({ binder: newClean }, note.id);
        }
        this.refreshBinderList();
      },
      delete: async (name: string) => {
        if (this.binders.sync.writesLocally) return this.binders.delete(name);
        const clean = String(name || '').trim();
        if (!clean) return;
        this.saveStoredBinders(this.storedBinders().filter(item => item.toLowerCase() !== clean.toLowerCase()));
        for (const note of this.note.all.filter(note => (note.binder || '').toLowerCase() === clean.toLowerCase())) {
          if (note.id) await this.Notes.updateKey({ binder: '' }, note.id);
        }
        this.refreshBinderList();
      }
    }
  }

  // ? snakebar (aka toast) --------------------------------------

  snackBar(text: { action: string, opposite: string }, obj: UpdateKeyI, noteId: number) {
    Snackbar.show({
      pos: 'bottom-left',
      text: `Note ${text.action}`,
      actionText: 'Undo',
      duration: 4200,
      onActionClick: () => {
        const uObj = obj as any
        if (uObj['rejoin']) {
          this.Notes.rejoin(noteId, uObj['userId'] as number)
        } else {
          this.note.id = noteId
          this.note.db.updateKey(obj)
        }
        Snackbar.show({
          pos: 'bottom-left',
          text: `Note ${text.opposite}`,
          duration: 3000,
        })
      }
    })
  }


  // ? Tooltip --------------------------------------

  createTooltip(button: HTMLElement, tooltipEl: HTMLDivElement, placement: Placement = 'bottom') {
    this.removeTooltipOutsideListener(tooltipEl)
    tooltipEl.dataset['isTooltipOpen'] = 'true'
    createPopper(button, tooltipEl, { placement })
    // Defer the outside-click listener by one frame and use `click` instead
    // of `mousedown`. On iOS the first tap on a menu item arrives via the
    // synthetic mousedown → click sequence; if we listen on mousedown we
    // race the menu item's click handler and can close the tooltip before
    // it fires, which the user perceives as needing to tap twice.
    const fct = (event: Event) => {
      const target = event.target as Node
      if (!tooltipEl.contains(target) && !button.contains(target)) {
        this.closeTooltip(tooltipEl)
      }
    }
    this.tooltipOutsideListeners.set(tooltipEl, fct)
    requestAnimationFrame(() => {
      if (tooltipEl.dataset['isTooltipOpen'] !== 'true') return
      document.addEventListener('click', fct, true)
    })
  }

  closeTooltip(tooltipEl: HTMLDivElement) {
    tooltipEl.dataset['isTooltipOpen'] = 'false'
    this.removeTooltipOutsideListener(tooltipEl)
  }

  private removeTooltipOutsideListener(tooltipEl: HTMLDivElement) {
    const listener = this.tooltipOutsideListeners.get(tooltipEl)
    if (!listener) return
    document.removeEventListener('click', listener, true)
    this.tooltipOutsideListeners.delete(tooltipEl)
  }

}
