import { Injectable, NgZone } from '@angular/core';
import { NoteI, NoteModelI, UpdateKeyI } from '../interfaces/notes';
import { NotesService } from './notes.service';
import { BehaviorSubject, Subject } from 'rxjs';
import { LabelsService } from './labels.service';
import { LabelI, LabelModelI } from '../interfaces/labels';
import { bgColors, bgImages } from '../interfaces/tooltip';
import { AuthService } from './auth.service';
import { ReminderService } from './reminder.service';
import { createPopper, type Placement } from '@popperjs/core';
declare var Snackbar: any
@Injectable({
  providedIn: 'root'
})
export class SharedService {
  private tooltipOutsideListeners = new WeakMap<HTMLDivElement, (event: Event) => void>();

  // PWA State
  deferredInstallPrompt?: any;
  isIos = false;
  isMobile = false;
  isStandalone = false;
  showInstallButton = new BehaviorSubject<boolean>(false);

  private creatingExamples = false;

  constructor(
    private Notes: NotesService,
    private Labels: LabelsService,
    private auth: AuthService,
    private reminders: ReminderService,
    private ngZone: NgZone
  ) {
    // Wire the result subscriptions once. Loads happen in response to
    // currentUser$ — that way a fresh login (or a session that arrives
    // after async auth bootstrap, common on iOS Safari/PWA) triggers a
    // load. Without this, the constructor-time load runs before the
    // session is ready and the page stays blank until manual refresh.
    this.Labels.labelsList$.subscribe({
      next: (result: LabelI[]) => this.label.list = [...result].reverse(),
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
        })
      },
      error: error => console.error(error)
    })

    this.auth.currentUser$.subscribe(async user => {
      if (user?.token) {
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
      }
    })
  }

  closeSideBar = new Subject<boolean>()
  openMobileComposer = new Subject<boolean>()
  openSelectedReminder = new Subject<void>()
  saveNote = new Subject<boolean>()
  closeModal = new Subject<boolean>()
  noteViewType = new BehaviorSubject<'list' | 'grid'>('grid')
  selectedNoteIds = new BehaviorSubject<number[]>([])
  searchQuery = ''

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

  async refreshData() {
    await Promise.all([
      this.Notes.load(),
      this.Labels.load()
    ])
  }

  toggleNoteSelection(noteId: number) {
    const selected = this.selectedNoteIds.value
    this.selectedNoteIds.next(selected.includes(noteId) ? selected.filter(id => id !== noteId) : [...selected, noteId])
  }

  clearNoteSelection() {
    this.selectedNoteIds.next([])
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
    for (const noteId of this.selectedNoteIds.value) {
      await this.Notes.updateKey({ trashed: true, archived: false }, noteId)
    }
    this.clearNoteSelection()
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
    // Mark server-side immediately so a re-entrant load doesn't double-seed.
    // (We mark before creating; if the inserts fail mid-way the user can
    // delete demos manually — never spam them with duplicates.)
    try { await this.auth.markDemoNotesCreated(); } catch {}

    try {
      // 1. Link Card (Pinned!)
      await this.Notes.add({
        noteTitle: 'Saved Links 🔗',
        noteBody: 'You can save links in Kept and they\'ll automatically generate a full preview for you! Check out the project here: https://github.com/ericerkz/kept',
        bgColor: bgColors.sky,
        pinned: true, archived: false, trashed: false, isCbox: false, labels: [],
        isDemo: true
      } as any);

      // 2. Todo Card
      await this.Notes.add({
        noteTitle: 'My Cozy Day Plan (Checklist!) ☁️',
        noteBody: 'Look! You can make sweet little checklists to keep track of your day. Just like this one! ✨',
        isCbox: true,
        checkBoxes: [
          { data: 'Sip some Oat milk latte ☕', done: true, id: 1 },
          { data: 'Watch newest season of Aggretusko 🤘', done: true, id: 2 },
          { data: 'Migrate off Google Keep', done: false, id: 3 }
        ],
        bgColor: bgColors.creamsicle,
        pinned: false, archived: false, trashed: false, labels: [],
        isDemo: true
      } as any);

      // 3. Label Card — create the actual label record first so it shows up
      // in the sidenav, label menu, and editor (the editor only renders
      // labels whose name matches an entry in the user's labels list).
      let sweetThoughtsLabelId: number | undefined;
      try {
        sweetThoughtsLabelId = await this.Labels.add({ name: 'Sweet Thoughts' } as LabelI);
      } catch {
        // Non-fatal — the note will still be created without a usable label.
      }
      await this.Notes.add({
        noteTitle: 'Everything in its place! 🎀',
        noteBody: 'Keep things tidy and sweet with labels. This one is for your most special thoughts! ✨',
        bgColor: bgColors.lavender,
        labels: sweetThoughtsLabelId
          ? [{ id: sweetThoughtsLabelId, name: 'Sweet Thoughts', added: true }]
          : [{ name: 'Sweet Thoughts', added: true }],
        pinned: false, archived: false, trashed: false, isCbox: false,
        isDemo: true
      } as any);

      // 4. Drawing Demo Card
      await this.Notes.add({
        noteTitle: 'Doodle Corner (Canvas Note!) 🖍️',
        noteBody: 'Click the paint icon to start your first masterpiece. You can even draw lists like this one! ✨',
        bgColor: bgColors.mint,
        images: [{
          id: 'drawing', // Using the reserved 'drawing' ID to trigger canvas-note behavior
          dataUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjQwMCIgdmlld0JveD0iMCAwIDQwMCA0MDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPGcgc3Ryb2tlPSIjMjAyMTI0IiBzdHJva2Utd2lkdGg9IjQiIGZpbGw9Im5vbmUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8IS0tIEJyZWFkIC0tPgogICAgPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCwgMCkiPgogICAgICA8cGF0aCBkPSJNIDUwIDYwIGMgMCAyMCAwIDQwIDUgNjAgbSAtNSAtNjAgYyAyMCAwIDMwIDUgMzAgMjAgYyAwIDEwIC0xMCAxNSAtMzAgMTUgYyAyMCAwIDM1IDUgMzUgMjUgYyAwIDE1IC0xNSAyMCAtMzUgMjAiIC8+CiAgICAgIDxwYXRoIGQ9Ik0gOTUgOTAgbCAwIDMwIG0gMCAtMjAgYyAxMCAtMTAgMjAgLTUgMjAgNSIgLz4KICAgICAgPHBhdGggZD0iTSAxMjUgMTEwIGwgMzAgMCBjIDAgLTIwIC0zMCAtMjAgLTMwIDAgYyAwIDIwIDMwIDIwIDMwIDEwIiAvPgogICAgICA8cGF0aCBkPSJNIDE2NSAxMTAgYyAwIC0yMCAzMCAtMjAgMzAgMCBsIDAgMjAgbSAwIC0yMCBjIC0zMCAwIC0zMCAyMCAwIDIwIiAvPgogICAgICA8cGF0aCBkPSJNIDIyNSA2MCBsIDAgNjAgYyAwIDE1IC0yMCAxNSAtMjAgMCBjIDAgLTE1IDIwIC0xNSAyMCAwIiAvPgogICAgICA8cGF0aCBkPSJNIDQwIDEwNSBjIDQwIC01LCAxMjAgNSwgMjAwIDAiIHN0cm9rZS13aWR0aD0iMyIgb3BhY2l0eT0iMC43IiAvPgogICAgPC9nPgogICAgPCEtLSBFZ2dzIC0tPgogICAgPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCwgMTAwKSI+CiAgICAgIDxwYXRoIGQ9Ik0gNTAgMTEwIGwgMzAgMCBjIDAgLTIwIC0zMCAtMjAgLTMwIDAgYyAwIDIwIDMwIDIwIDMwIDEwIiAvPgogICAgICA8cGF0aCBkPSJNIDk1IDExMCBjIDAgMTUgLTIwIDE1IC0yMCAwIGMgMCAtMTUgMjAgLTE1IDIwIDAgbCAwIDIwIGMgMCAxMCAtMjAgMTAgLTIwIDAiIC8+CiAgICAgIDxwYXRoIGQ9Ik0gMTMwIDExMCBjIDAgMTUgLTIwIDE1IC0yMCAwIGMgMCAtMTUgMjAgLTE1IDIwIDAgbCAwIDIwIGMgMCAxNSAtMzAgMTUgLTMwIDAiIC8+CiAgICAgIDxwYXRoIGQ9Ik0gMTY1IDExMCBjIDAgMTAgMzAgMTAgMzAgMjAgYyAwIDEwIC0zMCAxMCAtMzAgMjAiIC8+CiAgICAgIDxwYXRoIGQ9Ik0gNDAgMTIwIGMgNDAgNSwgMTAwIC01LCAxNjAgMyIgc3Ryb2tlLXdpZHRoPSIzIiBvcGFjaXR5PSIwLjciIC8+CiAgICA8L2c+CiAgICA8IS0tIEhlYXJ0IChSaWdodCBTaWRlLCBUaWx0ZWQgLSBGaXhlZCBQYXRoKSAtLT4KICAgIDxwYXRoIGQ9Ik0zMzQsMTAzIGMtOCwtMTYgLTMyLC0xNiAtMzIsMCBjMCwxNiAxNiwzMiAzMiw0OCBjMTYsLTE2IDMyLC0zMiAzMiwtNDggYzAsLTE2IC0yNCwtMTYgLTMyLDAiIGZpbGw9IiNmOGJiZDAiIHN0cm9rZT0iI2YwNjI5MiIgc3Ryb2tlLXdpZHRoPSIyLjUiIC8+CiAgPC9nPgo8L3N2Zz4=',
          name: 'Handwritten List|bg:rules',
          placement: 'top'
        }],
        pinned: false, archived: false, trashed: false, isCbox: false, labels: [],
        isDemo: true
      } as any);

      // 5. Image Card
      await this.Notes.add({
        noteTitle: 'Our Icon (In-Situ Images!) ✨',
        noteBody: 'This card shows how you can add beautiful images directly to your notes. <div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="/assets/images/keep2x.png" alt="logo"></div> It\'s the perfect way to save your favorite memories right in the middle of your text! 🥰',
        bgColor: bgColors.cornflower,
        pinned: false, archived: false, trashed: false, isCbox: false, labels: [],
        isDemo: true
      } as any);

      // 6. Reminder Card — also showcases the per-note background-image
      // option via the "romantic" hearts illustration.
      const noteId = await this.Notes.add({
        noteTitle: 'A Little Nudge... ⏰',
        noteBody: 'Set a reminder and we\'ll handle the whole "remembering-things" stuff - with push notifications across all devices. If you have a preferred calendar for that stuff, you can set them up to sync to that, too.<br><br>Bonus: this card uses a background image — try the palette icon in the toolbar to set your own.',
        bgColor: bgColors.flamingo,
        bgImage: `url(${bgImages.romantic})`,
        pinned: false, archived: false, trashed: false, isCbox: false, labels: [],
        isDemo: true
      } as any);

      if (noteId && noteId !== -1) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        await this.reminders.create({
          noteId,
          dueAtUtc: tomorrow.toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          title: 'A Little Nudge... ⏰',
          body: 'Kept will handle the whole "remembering-things" stuff with push notifications across all devices.'
        });
      }

      // 7. Attachment Card — demonstrates the file-attachment feature with a
      // tiny welcome .txt file generated client-side and uploaded through
      // the regular attachment endpoint.
      const attachmentNoteId = await this.Notes.add({
        noteTitle: 'Files Welcome 📎',
        noteBody: 'Need to keep a PDF, doc, or zip alongside your notes? Drop in any file up to 25 MB with the paperclip icon. Files download with their original names — perfect for receipts, manuals, or that ZIP you keep losing track of. 📂',
        bgColor: bgColors.peach,
        pinned: false, archived: false, trashed: false, isCbox: false, labels: [],
        isDemo: true
      } as any);

      if (attachmentNoteId && attachmentNoteId !== -1) {
        const welcomeText =
          'Welcome to Kept!\n' +
          '================\n\n' +
          'This little file is here to show off how attachments work.\n' +
          'You can drop in PDFs, Office docs, ZIPs, plain text, and more —\n' +
          'up to 25 MB each. Files keep their original names on download,\n' +
          'so receipts, manuals, and anything else you want to keep next\n' +
          'to a note are just a click away.\n\n' +
          '— Kept ✨\n';
        const file = new Blob([welcomeText], { type: 'text/plain' });
        try {
          await this.Notes.uploadAttachment(attachmentNoteId, file, 'welcome.txt');
        } catch (e) {
          console.warn('Could not attach demo welcome.txt', e);
        }
      }

    } catch (e) {
      console.error('Failed to create example notes', e);
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
