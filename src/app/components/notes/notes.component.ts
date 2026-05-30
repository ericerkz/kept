import { CheckboxI, NoteAttachmentI, NoteI, NoteImageI } from './../../interfaces/notes';
import { AfterViewChecked, ChangeDetectorRef, Component, HostListener, NgZone, OnDestroy, OnInit, ViewChild, ElementRef, ViewChildren, QueryList } from '@angular/core';
// @ts-ignore
import Bricks from 'bricks.js'
import { Subscription } from 'rxjs';
import { SharedService } from 'src/app/services/shared.service';
import { bgColors, bgImages } from 'src/app/interfaces/tooltip';
import { LabelI } from 'src/app/interfaces/labels';
import { ActivationEnd, NavigationEnd, Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';
import { ShareUserI } from 'src/app/interfaces/users';
import { ReminderService } from 'src/app/services/reminder.service';
import { NotesService } from 'src/app/services/notes.service';
import { TimepickerUI, type ConfirmEventData } from 'timepicker-ui';
import { NotesToolsPipe } from 'src/app/pipes/notes-tools.pipe';

declare var Snackbar: any;
type NoteBodySegment = { type: 'html'; value: string } | { type: 'url'; value: string }
type NoteBodyPreview = { segments: NoteBodySegment[]; urls: string[] }
type NoteMeta = { rawBody: string; title: string; bgKey: string; urls: string[]; linkOnly: boolean; textColor: string; displayBody: string; bodySegments: NoteBodySegment[]; hiddenLinkCount: number; visibleUrls: string[] }
@Component({
    selector: 'app-notes',
    templateUrl: './notes.component.html',
    styleUrls: ['./notes.component.scss'],
    providers: [NotesToolsPipe],
    standalone: false
})
export class NotesComponent implements OnInit, OnDestroy, AfterViewChecked {
  activeNote: NoteI | null = null
  constructor(public Shared: SharedService, private router: Router, public auth: AuthService, public reminderService: ReminderService, private zone: NgZone, public notesService: NotesService, private cd: ChangeDetectorRef, private notesTools: NotesToolsPipe) { }

  private subscriptions: Subscription[] = []

  @ViewChild("mainContainer") mainContainer!: ElementRef<HTMLInputElement>
  @ViewChild("modalContainer") modalContainer!: ElementRef<HTMLInputElement>
  @ViewChild("modal") modal!: ElementRef<HTMLInputElement>
  @ViewChild('overviewImageInput') overviewImageInput?: ElementRef<HTMLInputElement>
  @ViewChild('globalReminderTime') globalReminderTime?: ElementRef<HTMLInputElement>
  @ViewChild('loadMoreSentinel') loadMoreSentinel?: ElementRef<HTMLDivElement>
  private pendingPickerNote: NoteI | null = null
  @ViewChildren('noteEl') noteEl!: QueryList<ElementRef<HTMLDivElement>>
  @ViewChildren('title') title!: QueryList<ElementRef<HTMLDivElement>>
  //? -----------------------------------------------------
  currentPage = {
    archive: false,
    trash: false,
    label: undefined as string | undefined,
    reminders: false,
    shared: false,
    attachments: false
  }
  currentPageName = ''
  labels: LabelI[] = []
  bgColors = bgColors
  bgImages = bgImages
  bgImageLabels: Record<string, string> = {
    groceries: 'Groceries',
    tasks: 'Errands',
    movies: 'Movies',
    cafes: 'Cafes',
    romantic: 'Love',
    gym: 'Gym',
    recipes: 'Recipes',
    travel: 'Travel',
    study: 'Study',
    ideas: 'Ideas',
    meetings: 'Meetings',
    budget: 'Budget',
    zNone: 'None'
  }
  noteWidth = 240
  clickedNoteData: NoteI = {} as NoteI
  collaboratorNote?: NoteI
  collaboratorUsers: ShareUserI[] = []
  selectedCollaboratorIds: number[] = []
  collaboratorError = ''
  labelMenuError = ''
  isSavingCollaborators = false
  openImagePickerOnModal = false
  activePickerNoteId: number | null = null

  // Returns the note object the date picker is currently open for. Used by
  // the template's body-level reminder-date-dialog (the dialog is rendered
  // at component root rather than inside each note card so it's not trapped
  // by ancestor transforms — bricks.js applies translate3d to .note-container,
  // which creates a containing block for position:fixed descendants).
  get activePickerNote(): NoteI | null {
    if (this.activePickerNoteId == null) return null
    return this.Shared.note.all.find(n => n.id === this.activePickerNoteId) || null
  }
  customPickerOpen = false
  customDate = ''
  customTime = ''
  readonly calendarWeekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  calendarMonth = this.startOfMonth(new Date())
  private customTimePicker?: TimepickerUI
  private customTimePickerInput?: HTMLInputElement
  private timePickerNote?: NoteI
  private timePickerDateInput?: HTMLInputElement
  private lastMasonrySignature = ''
  private masonrySignatureToken = 0
  private masonryQueued = false
  private noteMetaCache = new WeakMap<NoteI, NoteMeta>()
  private reminderLookupCache?: { reminders: any[]; byNoteId: Map<number, any> }
  private trashCountdownCache = new WeakMap<NoteI, { trashedAt: string; bucket: number; value: string }>()
  private reminderDateCache = new Map<string, string>()
  private pendingPermanentDeletes = new Map<number, { note: NoteI; allIndex: number; pinnedIndex: number; unpinnedIndex: number; timer: ReturnType<typeof setTimeout> }>()
  draggedNoteId?: number
  noteOrderChanged = false
  suppressNextOpen = false
  private overviewImageNote: NoteI | null = null
  // Initial visible chunk is small (≈ a single viewport on most screens) so
  // first paint is instant — masonry renders, the user sees notes, then we
  // expand on the next animation frame to fill in the rest above-the-fold.
  visibleNoteLimit = 24
  private readonly noteRenderChunk = 80
  private readonly initialNoteRenderChunk = 24
  private didInitialExpand = false
  private lastRenderContext = ''
  private loadMoreObserver?: IntersectionObserver
  private isBackfillingFilteredPage = false
  private lastBackfillContext = ''
  private searchLayoutQueued = false
  private smartCaptureLayoutQueued = false
  private pendingSmartCaptureReloadSettle = false
  private smartCaptureNotesAddedHandler = () => this.handleSmartCaptureNotesAdded()
  private observedLoadMoreSentinel?: HTMLDivElement
  private modalScrollRestoreTimers: ReturnType<typeof setTimeout>[] = []
  private modalOpenScrollY = 0
  private modalClosing = false
  private suppressScrollPaginationUntil = 0
  private lastOverviewCheckboxTouchAt = 0
  private keptAppReadyQueued = false
  private keptAppReadySent = false
  private keptAppReadyRetry?: ReturnType<typeof setTimeout>
  //? -----------------------------------------------------
  trackBy(_index: number, item: any) { return item.id }

  isLinkOnlyNote(note: NoteI): boolean {
    return this.noteMeta(note).linkOnly
  }

  openExternalLink(event: MouseEvent, url: string) {
    event.stopPropagation();
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  isLightColor(color: string) {
    const rgb = this.parseColor(color)
    if (!rgb) return false
    return ((rgb.r * 299) + (rgb.g * 587) + (rgb.b * 114)) / 1000 > 160
  }

  noteTextColor(note: NoteI) {
    return this.noteMeta(note).textColor
  }

  noteDisplayBody(note: NoteI) {
    return this.noteMeta(note).displayBody
  }

  noteBodySegments(note: NoteI): NoteBodySegment[] {
    return this.noteMeta(note).bodySegments
  }

  visibleLinkUrls(note: NoteI): string[] {
    return this.noteMeta(note).visibleUrls
  }

  hiddenLinkCount(note: NoteI): number {
    return this.noteMeta(note).hiddenLinkCount
  }

  imageSrc(src: string) {
    return this.auth.authenticatedImageUrl(src)
  }

  trackBodySegment(index: number, segment: NoteBodySegment) {
    return `${index}:${segment.type}:${segment.value}`
  }

  // True for hybrid (merged) notes — both a real body and a checklist. The
  // grid card renders the body section in addition to the checkboxes.
  isHybridCard(note: NoteI): boolean {
    if (!note.isCbox) return false
    const text = (note.noteBody || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    return text.length > 0
  }

  private noteMeta(note: NoteI) {
    const rawBody = note.noteBody || ''
    const title = note.noteTitle || ''
    const themeKey = document.body.classList.contains('light-theme') ? 'l' : 'd'
    const bgKey = `${note.bgColor || ''}|${note.bgImage || ''}|${note.isCbox ? 1 : 0}|${themeKey}`
    const cached = this.noteMetaCache.get(note)
    if (cached && cached.rawBody === rawBody && cached.title === title && cached.bgKey === bgKey) return cached

    const body = this.auth.authenticatedImageHtml(rawBody)
    const bodyPreview = this.buildBodySegments(body)
    const bodySegments = bodyPreview.segments
    const urls = bodyPreview.urls
    const visibleUrls = urls.slice(0, 3)
    const totalLinkCount = Math.max(note.linkCount || 0, urls.length)
    const hiddenLinkCount = Math.max(0, totalLinkCount - visibleUrls.length)
    const plainBody = body.replace(/<[^>]+>/g, ' ')
    const bodyWithoutUrls = plainBody.replace(/https?:\/\/\S+/g, '').replace(/&nbsp;/g, ' ').trim()
    const linkOnly = !note.isCbox && urls.length > 0 && !title.trim() && !bodyWithoutUrls
    const isLightMode = document.body.classList.contains('light-theme');
    const defaultTextColor = isLightMode ? '#202124' : '#e8eaed';
    const textColor = note.bgImage || (note.bgColor && this.isLightColor(note.bgColor)) ? '#202124' : (note.bgColor ? '#e8eaed' : defaultTextColor);

    const displayBody = urls.length ? this.hideLinksInHtml(body) : body
    const next = { rawBody, title, bgKey, urls, linkOnly, textColor, displayBody, bodySegments, hiddenLinkCount, visibleUrls }
    this.noteMetaCache.set(note, next)
    return next
  }

  private buildBodySegments(html: string): NoteBodyPreview {
    const div = document.createElement('div')
    div.innerHTML = html || ''
    div.querySelectorAll('app-link-preview, .editor-link-previews, .editor-link-preview-slot, .lp-card').forEach(el => el.remove())

    div.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
      const href = anchor.href || anchor.getAttribute('href') || ''
      const text = (anchor.textContent || '').trim()
      const url = /^https?:\/\//i.test(href) ? href : (/^https?:\/\//i.test(text) ? text : '')
      if (!url) return
      const placeholder = document.createElement('span')
      placeholder.dataset['previewUrl'] = url.replace(/[),.;:!?]+$/, '')
      anchor.replaceWith(placeholder)
    })

    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, {
      acceptNode: node => /https?:\/\/[^\s"'<>]+/.test(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    })
    const textNodes: Text[] = []
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
    textNodes.forEach(node => {
      const text = node.textContent || ''
      const fragment = document.createDocumentFragment()
      let lastIndex = 0
      for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
        const rawUrl = match[0]
        const start = match.index || 0
        const url = rawUrl.replace(/[),.;:!?]+$/, '')
        const trailing = rawUrl.slice(url.length)
        if (start > lastIndex) fragment.append(document.createTextNode(text.slice(lastIndex, start)))
        const placeholder = document.createElement('span')
        placeholder.dataset['previewUrl'] = url
        fragment.append(placeholder)
        if (trailing) fragment.append(document.createTextNode(trailing))
        lastIndex = start + rawUrl.length
      }
      if (lastIndex < text.length) fragment.append(document.createTextNode(text.slice(lastIndex)))
      node.replaceWith(fragment)
    })

    const segments: NoteBodySegment[] = []
    const urls: string[] = []
    const seenUrls = new Set<string>()
    const renderedUrls = new Set<string>()
    let buffer = document.createElement('div')

    const flushBuffer = () => {
      const html = buffer.innerHTML.replace(/^(?:<br\s*\/?>|\s)+|(?:<br\s*\/?>|\s)+$/g, '')
      if (html) segments.push({ type: 'html', value: html })
      buffer = document.createElement('div')
    }

    const walk = (root: Node) => {
      for (const node of Array.from(root.childNodes)) {
        if (node.nodeType === 1 && (node as HTMLElement).dataset?.['previewUrl']) {
          const url = (node as HTMLElement).dataset['previewUrl']!
          if (!seenUrls.has(url)) {
            seenUrls.add(url)
            urls.push(url)
          }
          if (!renderedUrls.has(url) && renderedUrls.size < 3) {
            flushBuffer()
            segments.push({ type: 'url', value: url })
            renderedUrls.add(url)
          }
        } else if (node.nodeType === 1) {
          const placeholders = (node as Element).querySelectorAll('[data-preview-url]')
          if (placeholders.length === 0) {
            buffer.appendChild(node.cloneNode(true))
          } else {
            flushBuffer()
            walk(node)
            flushBuffer()
          }
        } else {
          buffer.appendChild(node.cloneNode(true))
        }
      }
    }

    walk(div)
    flushBuffer()

    return { segments, urls }
  }

  private hideLinksInHtml(html: string) {
    const div = document.createElement('div')
    div.innerHTML = html || ''
    div.querySelectorAll('app-link-preview, .editor-link-previews, .editor-link-preview-slot, .lp-card').forEach(el => el.remove())

    div.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
      const href = anchor.href || anchor.getAttribute('href') || ''
      const text = anchor.textContent || ''
      if (/^https?:\/\//i.test(href) || /^https?:\/\//i.test(text.trim())) anchor.remove()
    })

    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, {
      acceptNode: node => /https?:\/\/[^\s"'<>]+/.test(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    })
    const textNodes: Text[] = []
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
    textNodes.forEach(node => {
      const next = (node.textContent || '').replace(/https?:\/\/[^\s"'<>]+/g, '').replace(/[ \t]{2,}/g, ' ')
      node.textContent = next
    })

    div.querySelectorAll('br').forEach(br => {
      const previous = br.previousSibling
      const next = br.nextSibling
      if ((!previous || !previous.textContent?.trim()) && (!next || !next.textContent?.trim())) br.remove()
    })

    return div.innerHTML.trim()
  }

  trashCountdown(note: NoteI) {
    if (!note.trashedAt) return '10 days left'
    // Recompute at most once per minute per note; the value only changes once per day.
    const bucket = Math.floor(Date.now() / 60000)
    const cached = this.trashCountdownCache.get(note)
    if (cached && cached.trashedAt === note.trashedAt && cached.bucket === bucket) return cached.value
    const trashedAt = new Date(note.trashedAt).getTime()
    if (Number.isNaN(trashedAt)) {
      const fallback = '10 days left'
      this.trashCountdownCache.set(note, { trashedAt: note.trashedAt, bucket, value: fallback })
      return fallback
    }
    const expiresAt = trashedAt + 10 * 24 * 60 * 60 * 1000
    const daysLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
    const value = `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
    this.trashCountdownCache.set(note, { trashedAt: note.trashedAt, bucket, value })
    return value
  }

  private syncCurrentPage(url: string) {
    this.currentPage.archive = url.includes('archive')
    this.currentPage.trash = url.includes('trash')
    this.currentPage.shared = url.includes('shared')
    this.currentPage.reminders = url.includes('reminders')
    this.currentPage.attachments = url.includes('attachments')
    this.currentPage.label = this.labelNameFromUrl(url)
    this.updateCurrentPageName()
  }

  private labelNameFromUrl(url: string) {
    const path = url.split('?')[0].split('#')[0]
    const match = path.match(/\/label\/([^/]+)/)
    if (!match) return undefined
    try {
      return decodeURIComponent(match[1])
    } catch {
      return match[1]
    }
  }

  private updateCurrentPageName() {
    this.currentPageName = this.currentPage.label ? this.currentPage.label : this.currentPage.archive ? 'archived' : (this.currentPage.trash ? 'trashed' : this.currentPage.reminders ? 'reminders' : this.currentPage.attachments ? 'attachments' : this.currentPage.shared ? 'shared' : 'home')
  }

  private parseColor(color: string) {
    if (!color) return null
    const hex = color.trim().match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
    if (hex) {
      return {
        r: parseInt(hex[1], 16),
        g: parseInt(hex[2], 16),
        b: parseInt(hex[3], 16)
      }
    }

    const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
    if (!rgb) return null
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3])
    }
  }

  buildMasonry() {
    if (!this.mainContainer || !this.noteEl) return
    let gutter = 10
    let totalNoteWidth = this.noteWidth + gutter
    let containerWidth = this.mainContainer.nativeElement.clientWidth
    let numberOfColumns = 0
    let masonryWidth = '0px'
    // --
    if (this.Shared.noteViewType.value === 'grid') {
      // On mobile screens, use a smaller note width so 2 columns fit
      if (containerWidth < 600) {
        this.noteWidth = Math.floor((containerWidth - gutter * 3) / 2)
      } else {
        this.noteWidth = 240
      }
      numberOfColumns = Math.floor(containerWidth / (this.noteWidth + gutter))
      if (numberOfColumns < 2 && containerWidth >= 320) numberOfColumns = 2
    }
    else {
      if (this.mainContainer.nativeElement.clientWidth >= 600) this.noteWidth = 600
      else this.noteWidth = this.mainContainer.nativeElement.clientWidth - 10
      numberOfColumns = 1
    }
    document.documentElement.style.setProperty('--note-width', this.noteWidth + "px")
    // --
    const sizes = [{ columns: numberOfColumns, gutter: gutter }]
    
    // We must wait for the CSS variable to be applied and the notes to resize
    // before we ask Bricks to pack them, otherwise it uses old widths.
    requestAnimationFrame(() => {
      this.noteEl.toArray().forEach(el => { brikcs(el.nativeElement) })
    })

    function brikcs(node: HTMLDivElement) {
      const instance = Bricks({ container: node, packed: 'data-packed', sizes: sizes, position: false });
      instance.pack()
    }
    window.onresize = () => { if (this.Shared.noteViewType.value === 'list') this.Shared.noteViewType.next('grid') }
    //? we align the titles to the masonry width
    this.title.forEach(el => {
      if (this.Shared.noteViewType.value === 'list') el.nativeElement.style.maxWidth = masonryWidth
      else el.nativeElement.style.maxWidth = ''
    })
  }

  scheduleBuildMasonry(force = false) {
    if (!force) {
      const signature = this.masonrySignature()
      if (signature === this.lastMasonrySignature) return
      this.lastMasonrySignature = signature
    }
    if (this.masonryQueued) return
    this.masonryQueued = true
    requestAnimationFrame(() => {
      this.masonryQueued = false
      this.buildMasonry()
    })
  }

  private masonrySignature() {
    // Cheap signature: a token bumped on note-list mutation + the few inputs that
    // can vary outside of the notes list. Avoids iterating every note per CD cycle.
    return this.masonrySignatureToken
      + '|' + this.Shared.noteViewType.value
      + '|' + this.currentPageName
      + '|' + this.Shared.searchQuery
      + '|' + this.visibleNoteLimit
      + '|' + (this.mainContainer?.nativeElement?.clientWidth || 0)
      + '|' + (window?.innerWidth || 0)
  }

  increaseVisibleNoteLimit() {
    this.visibleNoteLimit += this.noteRenderChunk
    if (this.Shared.note.all.length - this.visibleNoteLimit < this.noteRenderChunk) this.loadMoreNotesIfNeeded()
    this.scheduleBuildMasonry(true)
  }

  visibleNotes(notes: NoteI[]) {
    return notes.slice(0, this.visibleNoteLimit)
  }

  canShowMoreLoadedNotes(notes: NoteI[]) {
    return notes.length > this.visibleNoteLimit
  }

  hasMoreServerNotes() {
    return this.notesService.hasMoreNotes
  }

  loadMoreNotesIfNeeded() {
    if (this.notesService.hasMoreNotes) this.notesService.loadNextPage().catch(console.error)
  }

  private pageNotes() {
    return this.notesTools.transform(this.Shared.note.all || [], this.currentPageName, this.Shared.searchQuery)
  }

  private maybeBackfillFilteredPage() {
    const notes = this.Shared.note.all || []
    if (!notes.length || !this.notesService.hasMoreNotes || this.isBackfillingFilteredPage) return
    if (this.pageNotes().length) return

    const context = `${this.currentPageName}:${this.Shared.searchQuery}:${notes.length}`
    if (context === this.lastBackfillContext) return
    this.lastBackfillContext = context
    this.isBackfillingFilteredPage = true
    Promise.resolve().then(async () => {
      try {
        while (this.notesService.hasMoreNotes && !this.pageNotes().length) {
          const before = this.Shared.note.all?.length || 0
          await this.notesService.loadNextPage()
          const after = this.Shared.note.all?.length || 0
          if (after <= before) break
        }
      } catch (error) {
        console.error(error)
      } finally {
        this.isBackfillingFilteredPage = false
        this.scheduleBuildMasonry(true)
      }
    })
  }

  private isSearchActive() {
    return !!this.Shared.searchQuery.trim()
  }

  private settleSearchResultsLayout() {
    if (!this.isSearchActive() || this.searchLayoutQueued) return
    this.searchLayoutQueued = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.zone.run(() => {
        this.searchLayoutQueued = false
        const filteredCount = this.pageNotes().length
        if (filteredCount) {
          this.visibleNoteLimit = Math.max(this.visibleNoteLimit, filteredCount, this.initialNoteRenderChunk)
        }
        this.masonrySignatureToken++
        this.scheduleBuildMasonry(true)
        setTimeout(() => this.scheduleBuildMasonry(true), 80)
      })
    }))
  }

  private observeLoadMoreSentinelIfNeeded() {
    if (!this.loadMoreObserver || !this.loadMoreSentinel?.nativeElement) return
    const sentinel = this.loadMoreSentinel.nativeElement
    if (this.observedLoadMoreSentinel === sentinel) return
    if (this.observedLoadMoreSentinel) this.loadMoreObserver.unobserve(this.observedLoadMoreSentinel)
    this.observedLoadMoreSentinel = sentinel
    this.loadMoreObserver.observe(sentinel)
  }

  private handleSmartCaptureNotesAdded() {
    this.pendingSmartCaptureReloadSettle = true
    this.settleSmartCaptureResultsLayout()
  }

  private settleSmartCaptureResultsLayout(notes?: NoteI[] | null) {
    if (!this.pendingSmartCaptureReloadSettle || this.smartCaptureLayoutQueued) return
    this.smartCaptureLayoutQueued = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.zone.run(() => {
        this.smartCaptureLayoutQueued = false
        this.pendingSmartCaptureReloadSettle = false
        const sourceNotes = notes || this.Shared.note.all || []
        const currentPageCount = this.notesTools.transform(sourceNotes, this.currentPageName, this.Shared.searchQuery).length
        if (currentPageCount) {
          const firstPageTarget = Math.min(currentPageCount, this.noteRenderChunk * 2)
          this.visibleNoteLimit = Math.max(this.visibleNoteLimit, firstPageTarget, this.initialNoteRenderChunk)
          this.didInitialExpand = true
        }
        this.suppressScrollPaginationUntil = Date.now() + 350
        this.masonrySignatureToken++
        this.scheduleBuildMasonry(true)
        setTimeout(() => this.scheduleBuildMasonry(true), 100)
        setTimeout(() => this.scheduleBuildMasonry(true), 260)
        setTimeout(() => window.dispatchEvent(new Event('resize')), 320)
      })
    }))
  }

  @HostListener('window:scroll')
  onWindowScroll() {
    if (Date.now() < this.suppressScrollPaginationUntil) return
    if (this.modalContainer?.nativeElement?.style.display === 'block' || this.modalClosing) return
    const remaining = document.documentElement.scrollHeight - (window.innerHeight + window.scrollY)
    if (remaining < 900) this.increaseVisibleNoteLimit()
  }

  //? modal  -----------------------------------------------------------

  async openModal(clickedNote: HTMLDivElement, noteData: NoteI, openImagePicker = false) {
    if (this.suppressNextOpen) {
      this.suppressNextOpen = false
      return
    }
    if (this.Shared.selectedNoteIds.value.length) {
      this.Shared.toggleNoteSelection(noteData.id!)
      return
    }
    this.openImagePickerOnModal = openImagePicker
    this.Shared.note.id = noteData.id!
    this.clickedNoteEl = clickedNote
    const source = clickedNote.getBoundingClientRect()
    this.suppressScrollPagination()
    this.captureModalScrollPosition()
    this.clickedNoteData = noteData.isCardPreview ? await this.notesService.get(noteData.id!, { merge: false }).catch(() => noteData) : noteData
    const modalContainer = this.modalContainer.nativeElement
    modalContainer.style.display = 'block';
    this.cd.detectChanges()
    this.prepareModalOpenAnimation(source)
    clickedNote.classList.add('hide')
    document.addEventListener('mousedown', this.mouseDownEvent)
  }

  mouseDownEvent = (event: Event) => {
    const target = event.target as HTMLElement
    const isTooltipOpen = !!document.querySelector('[data-is-tooltip-open="true"]')
    const isPickerClick = !!target.closest('.reminder-picker') || 
                          !!target.closest('.tp-ui-modal') || 
                          !!target.closest('.tp-ui-wrapper')
    
    // Check if clicking outside app-root (external modals like TimepickerUI)
    const appRoot = document.querySelector('app-root')
    const isOutsideApp = appRoot && !appRoot.contains(target)

    const modalEL = this.modal.nativeElement
    const isInsideModal = modalEL.contains(target)

    if (isInsideModal || isTooltipOpen || isPickerClick || isOutsideApp) {
      return
    }

    this.Shared.saveNote.next(true)
  }

  clickedNoteEl!: HTMLDivElement // needed in setModalStyling()

  @HostListener('document:keydown.escape')
  onEscapeKey() {
    if (this.modalContainer.nativeElement.style.display === 'block') {
      let isTooltipOpen = document.querySelector('[data-is-tooltip-open="true"]')
      if (!isTooltipOpen) {
        this.Shared.saveNote.next(true)
      }
    }
  }

  closeModal() {
    if (this.modalClosing) return
    this.modalClosing = true
    this.suppressScrollPagination()
    document.removeEventListener('mousedown', this.mouseDownEvent)
    let modalContainer = this.modalContainer.nativeElement
    const isMobileModal = window.innerWidth < 660
    this.prepareModalCloseAnimation()
    setTimeout(() => {
      this.clickedNoteEl.classList.remove('hide')
    }, isMobileModal ? 90 : 200)
    setTimeout(() => {
      modalContainer.style.display = 'none'
      this.openImagePickerOnModal = false
      this.modal.nativeElement.removeAttribute('style')
      this.restoreModalScrollPosition()
      this.scheduleIPadMasonrySettle()
      this.schedulePostModalPaginationCheck()
      this.suppressScrollPagination()
      this.modalClosing = false
    }, isMobileModal ? 180 : 400)
  }

  private suppressScrollPagination(durationMs = 1200) {
    this.suppressScrollPaginationUntil = Math.max(this.suppressScrollPaginationUntil, Date.now() + durationMs)
  }

  private captureModalScrollPosition() {
    this.clearModalScrollRestoreTimers()
    this.modalOpenScrollY = window.scrollY
  }

  private restoreModalScrollPosition() {
    if (Math.abs(window.scrollY - this.modalOpenScrollY) < 2) return
    this.queueModalScrollRestore(0)
    this.queueModalScrollRestore(80)
  }

  private queueModalScrollRestore(delay: number) {
    const timer = setTimeout(() => {
      requestAnimationFrame(() => window.scrollTo({ top: this.modalOpenScrollY }))
    }, delay)
    this.modalScrollRestoreTimers.push(timer)
  }

  private clearModalScrollRestoreTimers() {
    this.modalScrollRestoreTimers.forEach(timer => clearTimeout(timer))
    this.modalScrollRestoreTimers = []
  }

  private isIPadLikeViewport() {
    const ua = navigator.userAgent || ''
    const platform = navigator.platform || ''
    return /iPad/.test(ua) || /iPad/.test(platform) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  }

  private scheduleIPadMasonrySettle() {
    if (!this.isIPadLikeViewport()) return
    setTimeout(() => this.scheduleBuildMasonry(true), 220)
  }

  private schedulePostModalPaginationCheck() {
    setTimeout(() => {
      const remaining = document.documentElement.scrollHeight - (window.innerHeight + window.scrollY)
      if (remaining < 1200) {
        if (this.hasMoreServerNotes()) this.loadMoreNotesIfNeeded()
        else this.increaseVisibleNoteLimit()
      }
      this.observeLoadMoreSentinelIfNeeded()
    }, 1300)
  }

  private prepareModalOpenAnimation(source: DOMRect) {
    const modal = this.modal.nativeElement
    this.positionModalAtRest()
    const target = modal.getBoundingClientRect()
    this.setModalTransformFromRect(source, target, false)
    requestAnimationFrame(() => {
      modal.style.transition = ''
      modal.style.transform = 'none'
      modal.style.opacity = '1'
    })
  }

  private prepareModalCloseAnimation() {
    const source = this.clickedNoteEl.getBoundingClientRect()
    const modal = this.modal.nativeElement
    const target = modal.getBoundingClientRect()
    this.setModalTransformFromRect(source, target, true)
  }

  private positionModalAtRest() {
    const modal = this.modal.nativeElement
    if (window.innerWidth < 660) {
      modal.style.transition = 'none'
      modal.style.transformOrigin = 'top left'
      modal.style.transform = 'none'
      modal.style.opacity = '1'
      modal.style.width = '100%'
      modal.style.height = '100%'
      modal.style.left = '0'
      modal.style.top = '0'
      modal.style.borderRadius = '0'
      return
    }
    const width = Math.min(600, window.innerWidth - 34)
    modal.style.transition = 'none'
    modal.style.transformOrigin = 'top left'
    modal.style.transform = 'none'
    modal.style.opacity = '1'
    modal.style.width = `${width}px`
    modal.style.left = `${(window.innerWidth - width) / 2}px`
    modal.style.top = '20px'
    const height = modal.getBoundingClientRect().height
    modal.style.top = `${Math.max(20, (window.innerHeight - height) / 2)}px`
  }

  private setModalTransformFromRect(source: DOMRect, target: DOMRect, animate = false) {
    const modal = this.modal.nativeElement
    const scaleX = source.width / target.width
    const scaleY = source.height / target.height
    const translateX = source.left - target.left
    const translateY = source.top - target.top
    modal.style.transformOrigin = 'top left'
    modal.style.transition = animate ? (window.innerWidth < 660 ? 'transform 0.16s ease, opacity 0.12s ease' : '') : 'none'
    modal.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`
    modal.style.opacity = animate ? '0.98' : '1'
  }

  //? checkbox  -----------------------------------------------------------

  checkBoxTools(note: NoteI, event: Event) {
    this.Shared.note.id = note.id!
    event?.stopPropagation()
    let actions = {
      check: (cb: CheckboxI) => {
        cb.done = !cb.done
        this.scheduleBuildMasonry(true)
      },
      remove: (cb: CheckboxI) => {
        let index = note.checkBoxes?.findIndex(x => x === cb)
        if (index !== undefined) note.checkBoxes?.splice(index, 1)
        this.scheduleBuildMasonry(true)
      }
    }
    this.Shared.note.db.updateKey({ checkBoxes: note.checkBoxes })
    return actions
  }

  async toggleOverviewCheckbox(note: NoteI, cb: CheckboxI, event: Event) {
    event.stopPropagation()
    event.preventDefault()
    if (this.ignoreSyntheticOverviewCheckboxMouse(event)) return
    if (note.isCardPreview && note.id) note = await this.notesService.get(note.id).catch(() => note)
    const target = note.checkBoxes?.find(item => item.id === cb.id) || cb
    target.done = !target.done
    await this.notesService.updateKey({ checkBoxes: note.checkBoxes }, note.id!)
    this.scheduleBuildMasonry(true)
  }

  async removeOverviewCheckbox(note: NoteI, cb: CheckboxI, event: Event) {
    event.stopPropagation()
    event.preventDefault()
    if (this.ignoreSyntheticOverviewCheckboxMouse(event)) return
    if (note.isCardPreview && note.id) note = await this.notesService.get(note.id).catch(() => note)
    const index = note.checkBoxes?.findIndex(x => x.id === cb.id)
    if (index !== undefined && index >= 0) note.checkBoxes?.splice(index, 1)
    await this.notesService.updateKey({ checkBoxes: note.checkBoxes }, note.id!)
    this.scheduleBuildMasonry(true)
  }

  private ignoreSyntheticOverviewCheckboxMouse(event: Event) {
    if (event.type === 'touchend') {
      this.lastOverviewCheckboxTouchAt = Date.now()
      return false
    }
    return event.type.startsWith('mouse') && Date.now() - this.lastOverviewCheckboxTouchAt < 500
  }

  //? pin note  -----------------------------------------------------------

  togglePin(noteId: number, pinned: boolean) {
    this.Shared.note.id = noteId
    pinned = !pinned
    this.Shared.note.db.updateKey({ pinned: pinned })
  }

  toggleSelection(note: NoteI, event: Event) {
    event.stopPropagation()
    this.Shared.toggleNoteSelection(note.id!)
  }

  longPressNote(note: NoteI, event: TouchEvent) {
    event.preventDefault()
    this.Shared.toggleNoteSelection(note.id!)
  }

  // ---- Touch interaction state --------------------------------------
  // Single touch produces one of three outcomes (Google-Keep-style):
  //   • quick release, no movement      → tap → opens the note
  //   • 400ms hold + move               → drag-and-drop reorder
  //   • 400ms hold, no move, release    → toggles multi-select
  private longPressTimer: any = null
  private longPressFired = false
  private longPressStartX = 0
  private longPressStartY = 0

  private touchStartedAt = 0
  private touchMoved = false

  touchDragNote: NoteI | null = null
  private touchDragEl?: HTMLDivElement
  private touchDragMovedFromOrigin = false
  private touchDragNotes?: NoteI[]

  onTouchStart(note: NoteI, event: TouchEvent) {
    const touch = event.touches[0]
    this.longPressStartX = touch?.clientX ?? 0
    this.longPressStartY = touch?.clientY ?? 0
    this.longPressFired = false
    this.touchStartedAt = Date.now()
    this.touchMoved = false
    const noteEl = (event.currentTarget as HTMLDivElement) || ((event.target as HTMLElement).closest('.note-container') as HTMLDivElement)
    this.longPressTimer = setTimeout(() => {
      this.longPressFired = true
      this.beginTouchDrag(note, noteEl)
    }, 400)
  }

  onTouchMove(event: TouchEvent) {
    // While in drag mode, the document-level non-passive listener handles
    // movement so preventDefault() actually works (Angular binds (touchmove)
    // as passive).
    if (this.touchDragNote) return

    const touch = event.touches[0]
    if (!touch) return
    if (!this.longPressTimer && !this.touchStartedAt) return
    const dx = Math.abs(touch.clientX - this.longPressStartX)
    const dy = Math.abs(touch.clientY - this.longPressStartY)
    if (dx > 10 || dy > 10) {
      this.touchMoved = true
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer)
        this.longPressTimer = null
      }
    }
  }

  onTouchCancel() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
    if (this.touchDragNote) this.endTouchDrag(false)
    this.touchStartedAt = 0
    this.longPressFired = false
    this.touchMoved = false
  }

  onTouchEnd(noteEl: HTMLDivElement, note: NoteI, event: TouchEvent) {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }

    if (this.touchDragNote) {
      // The hold-pickup happened. Either we moved (reorder) or we didn't
      // (multi-select). endTouchDrag handles both branches.
      event.preventDefault()
      this.endTouchDrag(true)
      this.touchStartedAt = 0
      this.longPressFired = false
      return
    }

    const wasTap = !this.longPressFired && !this.touchMoved && (Date.now() - this.touchStartedAt) < 350
    this.touchStartedAt = 0
    this.longPressFired = false

    if (wasTap) {
      const target = event.target as HTMLElement
      if (target.closest('button, a, .reminder-chip, .reminder-picker, .check-icon, .cbox-icon, .cbox-cancel-icon, .pin-icon, .icons-container')) return
      event.preventDefault()
      this.openModal(noteEl, note)
      this.suppressNextOpen = true
      setTimeout(() => { this.suppressNextOpen = false }, 350)
    }
  }

  // ---- Touch drag-and-drop ------------------------------------------

  private touchDragMoveListener?: (e: TouchEvent) => void
  // Position of the card at pickup, in viewport coordinates. The ghost
  // (visual clone) is placed here and follows the finger by an offset
  // computed from this anchor — never from a position masonry can mutate.
  private touchDragPickupRect?: DOMRect
  private touchDragGhost?: HTMLElement

  private beginTouchDrag(note: NoteI, target: HTMLDivElement | null) {
    if (!target || !this.canReorderNote(note)) return
    this.touchDragNote = note
    this.touchDragEl = target
    this.touchDragMovedFromOrigin = false
    this.touchDragNotes = note.pinned ? this.Shared.note.pinned : this.Shared.note.unpinned
    this.draggedNoteId = note.id
    this.noteOrderChanged = false

    // Snapshot the card's screen rect at pickup. Use this as the anchor for
    // the ghost — masonry's per-card transforms can't move it once it's a
    // position:fixed clone outside the masonry container.
    const rect = target.getBoundingClientRect()
    this.touchDragPickupRect = rect

    // Keep the original card visible but dimmed so the user can still see
    // where the card "lives" while the ghost rides on top. The slot moves
    // with masonry as we reorder, giving a clear visual of the drop target.
    target.style.opacity = '0.35'
    target.style.pointerEvents = 'none'

    // Build a ghost: a clone that's position:fixed at the pickup rect.
    // The .touch-dragging-ghost class hard-disables transitions on the
    // clone so finger-tracking is 1:1 (no bell-curve lag from the cloned
    // .note-container's `transition: all 0.3s`). The pickup "pop"
    // animation is driven by the Web Animations API on a wrapper element
    // around the ghost — that way the pop animates scale + box-shadow
    // independently while the wrapper's children (the actual ghost
    // transform we write per touchmove) stay 1:1.
    const ghost = target.cloneNode(true) as HTMLElement
    ghost.removeAttribute('data-note-id')
    ghost.style.position = 'fixed'
    ghost.style.left = `${rect.left}px`
    ghost.style.top = `${rect.top}px`
    ghost.style.width = `${rect.width}px`
    ghost.style.margin = '0'
    ghost.style.transformOrigin = 'center center'
    ghost.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)'
    ghost.style.zIndex = '99999'
    ghost.style.pointerEvents = 'none'
    ghost.style.willChange = 'transform'
    ghost.style.transform = 'scale(1.04)'
    ghost.classList.add('touch-dragging-ghost')
    document.body.appendChild(ghost)
    this.touchDragGhost = ghost

    // Pickup pop via Web Animations API on box-shadow only. We can't
    // animate `transform` here — every touchmove writes a new inline
    // transform for finger tracking, and a WAAPI transform animation
    // would override those writes for its 180ms lifetime, freezing the
    // ghost in place at the start of the drag. Animating box-shadow
    // gives us the visual "lift" feel without conflicting; combined with
    // the haptic vibration above, the pickup reads as instantly tactile.
    try {
      ghost.animate(
        [
          { boxShadow: '0 0 0 rgba(0,0,0,0)' },
          { boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }
        ],
        { duration: 180, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' }
      )
    } catch { /* WAAPI not available — the inline box-shadow above still applies */ }

    // Tell iOS we own all touch interactions while drag is active — this
    // suppresses pan AND pinch-zoom system gestures inside the dragged
    // region. Without it, a stray second finger triggers iOS's zoom UI.
    document.documentElement.style.setProperty('touch-action', 'none')
    document.body.style.setProperty('touch-action', 'none')

    // Non-passive touchmove so preventDefault() blocks page scrolling and
    // pinch-zoom while a card is being dragged. Fast path: only update the
    // ghost transform here. Reorder hit-testing happens in a rAF loop so
    // we never block the scroll thread or fire 60+ reorders per second.
    this.touchDragMoveListener = (e: TouchEvent) => {
      if (!this.touchDragNote) return
      // Always prevent — even if a second finger is added, this stops iOS
      // from initiating its system pinch-zoom mid-drag.
      if (e.cancelable) e.preventDefault()
      const t = e.touches[0]
      if (!t) return
      this.touchDragLastX = t.clientX
      this.touchDragLastY = t.clientY
      this.fastUpdateGhost(t.clientX, t.clientY)
      this.scheduleReorderTick()
    }
    document.addEventListener('touchmove', this.touchDragMoveListener, { passive: false })

    try { (navigator as any).vibrate?.(15) } catch {}
  }

  private touchDragLastX = 0
  private touchDragLastY = 0
  private touchDragReorderQueued = false
  // Cooldown after a reorder so masonry's FLIP animation can settle before
  // we test for the next swap. Without this, the just-reordered neighbour
  // sometimes sits under the finger and we oscillate it back.
  private touchDragReorderUntil = 0

  private fastUpdateGhost(x: number, y: number) {
    if (!this.touchDragGhost) return
    const offsetX = x - this.longPressStartX
    const offsetY = y - this.longPressStartY
    if (Math.abs(offsetX) > 6 || Math.abs(offsetY) > 6) {
      this.touchDragMovedFromOrigin = true
    }
    this.touchDragGhost.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(1.04)`
  }

  private scheduleReorderTick() {
    if (this.touchDragReorderQueued) return
    this.touchDragReorderQueued = true
    requestAnimationFrame(() => {
      this.touchDragReorderQueued = false
      if (!this.touchDragNote) return
      if (Date.now() < this.touchDragReorderUntil) return
      this.checkReorder(this.touchDragLastX, this.touchDragLastY)
    })
  }

  private checkReorder(x: number, y: number) {
    if (!this.touchDragNote) return
    const pointEl = document.elementFromPoint(x, y) as HTMLElement | null
    const targetCard = pointEl?.closest('[data-note-id]') as HTMLElement | null
    if (!targetCard) return
    const targetId = Number(targetCard.dataset['noteId'])
    if (!targetId || targetId === this.touchDragNote.id) return

    const notes = this.touchDragNotes
    if (!notes) return
    const dragged = notes.find(n => n.id === this.touchDragNote!.id)
    const target = notes.find(n => n.id === targetId)
    if (!dragged || !target) return
    const from = notes.indexOf(dragged)
    const to = notes.indexOf(target)
    if (from < 0 || to < 0 || from === to) return

    notes.splice(from, 1)
    notes.splice(to, 0, dragged)
    if (notes === this.Shared.note.pinned) {
      this.Shared.note.pinned = [...notes]
      this.touchDragNotes = this.Shared.note.pinned
    } else {
      this.Shared.note.unpinned = [...notes]
      this.touchDragNotes = this.Shared.note.unpinned
    }
    this.Shared.note.all = [...this.Shared.note.pinned, ...this.Shared.note.unpinned]
    this.noteOrderChanged = true
    // Skip the FLIP animation during touch drag — Bricks repacks via the
    // signature-gated scheduleBuildMasonry on the next CD cycle, which is
    // cheap and visually clean. Running animateNoteRects every reorder
    // during a finger drag was the main source of jank.
    this.scheduleBuildMasonry(true)
    // Cooldown so we don't immediately re-swap before the layout settles.
    this.touchDragReorderUntil = Date.now() + 120
  }

  private endTouchDrag(committed: boolean) {
    const el = this.touchDragEl
    const note = this.touchDragNote
    const moved = this.touchDragMovedFromOrigin
    const notes = this.touchDragNotes

    if (this.touchDragMoveListener) {
      document.removeEventListener('touchmove', this.touchDragMoveListener)
      this.touchDragMoveListener = undefined
    }

    // Re-enable normal page scrolling / pinch-zoom (the latter still gated
    // by main.ts's gesturestart handler).
    document.documentElement.style.removeProperty('touch-action')
    document.body.style.removeProperty('touch-action')

    if (this.touchDragGhost) {
      this.touchDragGhost.remove()
      this.touchDragGhost = undefined
    }

    if (el) {
      el.style.opacity = ''
      el.style.pointerEvents = ''
    }
    this.touchDragNote = null
    this.touchDragEl = undefined
    this.touchDragMovedFromOrigin = false
    this.touchDragNotes = undefined
    this.touchDragPickupRect = undefined

    if (!committed || !note) {
      this.draggedNoteId = undefined
      this.noteOrderChanged = false
      return
    }

    if (moved && notes) {
      this.persistNoteOrder(notes)
    } else {
      this.Shared.toggleNoteSelection(note.id!)
    }
    this.suppressNextOpen = true
    setTimeout(() => { this.suppressNextOpen = false }, 350)
    this.draggedNoteId = undefined
  }

  openModalForImage(clickedNote: HTMLDivElement, noteData: NoteI, event: Event) {
    event.preventDefault()
    event.stopPropagation()
    if (!noteData.id) return
    this.openModal(clickedNote, noteData, true)
  }

  async overviewImageInputChange(event: Event) {
    const input = event.target as HTMLInputElement
    let note = this.overviewImageNote
    this.overviewImageNote = null
    if (!note?.id || !input.files?.length) {
      input.value = ''
      return
    }
    const files = Array.from(input.files).filter(file => file.type.startsWith('image/'))
    input.value = ''
    if (!files.length) return
    const imageData = await Promise.all(files.map(file => this.fileToNoteImage(file, 'bottom')))
    if (note.isCardPreview) {
      const fullNote = await this.notesService.get(note.id).catch(() => note)
      if (!fullNote) return
      note = fullNote
    }
    note.images = [...(note.images || []), ...imageData]
    this.masonrySignatureToken++
    this.Shared.note.id = note.id!
    await this.Shared.note.db.updateKey({
      images: note.images,
      isCbox: false
    })
    this.cd.detectChanges()
    this.scheduleBuildMasonry(true)
  }

  canReorderNote(note: NoteI) {
    return !!note.id && !note.trashed && !this.Shared.searchQuery
  }

  noteDragStart(note: NoteI, event: DragEvent) {
    if (!this.canReorderNote(note) || !note.id) {
      event.preventDefault()
      return
    }
    this.draggedNoteId = note.id
    this.noteOrderChanged = false
    event.dataTransfer?.setData('text/plain', String(note.id))
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  noteDragOver(targetNote: NoteI, notes: NoteI[], event: DragEvent) {
    if (!this.draggedNoteId) return this.dragOverImages(event)
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    if (!targetNote.id || targetNote.id === this.draggedNoteId) return
    if ((event.currentTarget as HTMLElement).getAnimations().length > 0) return
    const draggedNote = notes.find(note => note.id === this.draggedNoteId)
    if (!draggedNote || draggedNote.pinned !== targetNote.pinned) return
    const from = notes.indexOf(draggedNote)
    const to = notes.indexOf(targetNote)
    if (from < 0 || to < 0 || from === to) return
    // Midpoint guard: only swap when the cursor crosses the half-line of the
    // target. Without this, dragover fires continuously and the array
    // oscillates back and forth between the two positions on every event,
    // which the FLIP animation amplifies into a visible glitch.
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const movingForward = from < to
    const crossedMidpoint = movingForward
      ? event.clientX > rect.left + rect.width / 2 || event.clientY > rect.top + rect.height / 2
      : event.clientX < rect.left + rect.width / 2 || event.clientY < rect.top + rect.height / 2
    if (!crossedMidpoint) return
    const previousRects = this.getNoteRects()
    notes.splice(from, 1)
    notes.splice(to, 0, draggedNote)
    if (notes === this.Shared.note.pinned) {
      this.Shared.note.pinned = [...notes]
    } else {
      this.Shared.note.unpinned = [...notes]
    }
    this.Shared.note.all = [...this.Shared.note.pinned, ...this.Shared.note.unpinned]
    this.noteOrderChanged = true
    this.scheduleBuildMasonry(true)
    this.animateNoteRects(previousRects, this.draggedNoteId)
  }

  noteDrop(_targetNote: NoteI, notes: NoteI[], event: DragEvent): void {
    if (!this.draggedNoteId) {
      this.dropImageOnNote(_targetNote, event)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    this.persistNoteOrder(notes)
  }

  noteDragEnd(notes: NoteI[]) {
    if (this.draggedNoteId) {
      this.suppressNextOpen = true
      this.persistNoteOrder(notes)
    }
    this.draggedNoteId = undefined
    setTimeout(() => this.suppressNextOpen = false)
  }

  private persistNoteOrder(_notes: NoteI[]) {
    if (!this.noteOrderChanged) return
    this.noteOrderChanged = false
    this.Shared.note.db.reorder(this.loadedNoteOrderIds())
  }

  private loadedNoteOrderIds() {
    return [...this.Shared.note.pinned, ...this.Shared.note.unpinned]
      .map(note => note.id)
      .filter((id): id is number => !!id)
  }

  private getNoteRects() {
    const rects = new Map<number, DOMRect>()
    document.querySelectorAll<HTMLElement>('[data-note-id]').forEach(el => {
      const id = Number(el.dataset['noteId'])
      if (id) rects.set(id, el.getBoundingClientRect())
    })
    return rects
  }

  private animateNoteRects(previousRects: Map<number, DOMRect>, draggedId: number) {
    // Run after Angular CD + the masonry rAF have repositioned the cards.
    // bricks.js uses inline `transform: translate3d(...)` for layout, so we use
    // `composite: 'add'` to layer our delta on top of its position rather than
    // replace it (which would snap cards to 0,0 mid-animation).
    requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>('[data-note-id]').forEach(el => {
        const id = Number(el.dataset['noteId'])
        if (!id || id === draggedId) return
        const previousRect = previousRects.get(id)
        if (!previousRect) return
        const nextRect = el.getBoundingClientRect()
        const deltaX = previousRect.left - nextRect.left
        const deltaY = previousRect.top - nextRect.top
        if (!deltaX && !deltaY) return
        el.animate(
          [
            { transform: `translate(${deltaX}px, ${deltaY}px)` },
            { transform: 'translate(0, 0)' }
          ],
          { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)', composite: 'add' }
        )
      })
    })
  }

  dragOverImages(event: DragEvent) {
    if (!event.dataTransfer) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  async dropImageOnNote(note: NoteI, event: DragEvent) {
    if (!event.dataTransfer?.files?.length || !note.id) return
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'))
    if (!files.length) return
    const imageData = await Promise.all(files.map(file => this.fileToNoteImage(file, 'bottom')))
    if (note.isCardPreview && note.id) note = await this.notesService.get(note.id).catch(() => note)
    note.images = [...(note.images || []), ...imageData]
    this.masonrySignatureToken++
    this.Shared.note.id = note.id!
    await this.Shared.note.db.updateKey({
      images: note.images,
      isCbox: false
    })
    this.cd.detectChanges()
    this.scheduleBuildMasonry(true)
  }

  private fileToNoteImage(file: File, placement: NoteImageI['placement']): Promise<NoteImageI> {
    return this.Shared.note.db.uploadImage(file).then(uploaded => ({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      dataUrl: this.auth.authenticatedImageUrl(uploaded.url),
      name: uploaded.name || file.name,
      placement
    }))
  }

  private fileToInlineImageHtml(file: File): Promise<string> {
    return this.Shared.note.db.uploadImage(file).then(uploaded => this.inlineImageHtml(this.auth.authenticatedImageUrl(uploaded.url), uploaded.name || file.name))
  }

  private inlineImageHtml(dataUrl: string, name: string) {
    const safeName = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    return `<div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="${dataUrl}" alt="${safeName}"></div><div><br></div>`
  }

  //? labels -------------------------------------------------------------

  removeLabel(note: NoteI, label: LabelI) {
    this.Shared.note.id = note.id!
    label.added = !label.added
    this.Shared.note.db.updateKey({ labels: note.labels })
  }
  //? tooltip  -----------------------------------------------------------

  Ttbutton?: HTMLDivElement // used in moreMenu.openLabelMenu
  openTooltip(button: HTMLDivElement, tooltipEl: HTMLDivElement, note: NoteI) {
    this.activeNote = note
    this.Shared.note.id = note.id!
    this.Ttbutton = button
    this.Shared.createTooltip(button, tooltipEl)
  }

  moreMenu(tooltipEl: HTMLDivElement) {
    let actions = {
      trash: (note: NoteI) => {
        if (note.ownerUserId && note.ownerUserId !== this.auth.currentUser?.id) {
          const ownerName = note.ownerDisplayName || note.ownerUsername || 'the owner'
          const ok = confirm(`This note belongs to ${ownerName}, so you can't delete it — only the owner can. Remove yourself from this shared note instead?`)
          if (!ok) return
          const userId = this.auth.currentUser?.id
          this.notesService.delete(note.id!)
          this.Shared.snackBar({ action: 'left shared note', opposite: 'rejoined' }, { rejoin: true, userId } as any, note.id!)
        } else {
          this.Shared.note.db.trash()
        }
      },
      clone: () => {
        this.Shared.note.db.clone()
      },
      openLabelMenu: (tooltipEl: HTMLDivElement) => {
        this.labels = JSON.parse(JSON.stringify(this.Shared.label.list))
        this.labelMenuError = ''
        this.Shared.createTooltip(this.Ttbutton!, tooltipEl)
        this.Shared.note.db.get().then(note => {
          note.labels.forEach(noteLabel => {
            let label = this.labels.find(x => x.name === noteLabel.name)
            if (label) label.added = noteLabel.added
          })
        })
      }
    }
    this.Shared.closeTooltip(tooltipEl)
    return actions
  }

  colorMenu = {
    bgColor: (data: bgColors) => {
      this.Shared.note.db.updateKey({ bgColor: data })
    },
    bgImage: (data: bgImages) => {
      this.Shared.note.db.updateKey({ bgImage: `url(${data})` })
    }
  }

  labelMenu(label: LabelI) {
    label.added = !label.added
    this.Shared.note.db.updateKey({ labels: this.labels })
  }

  async addLabelFromMenu(input: HTMLInputElement) {
    const name = input.value.trim()
    if (!name) return

    const existing = this.labels.find(label => label.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      existing.added = true
      input.value = ''
      this.labelMenuError = ''
      this.Shared.note.db.updateKey({ labels: this.labels })
      return
    }

    try {
      const id = await this.Shared.label.db.add({ name })
      this.labels = [{ id, name, added: true }, ...this.labels]
      input.value = ''
      this.labelMenuError = ''
      this.Shared.note.db.updateKey({ labels: this.labels })
    } catch (error: any) {
      const matchingLabel = this.Shared.label.list.find(label => label.name.toLowerCase() === name.toLowerCase())
      if (matchingLabel) {
        this.labels = [{ ...matchingLabel, added: true }, ...this.labels]
        input.value = ''
        this.labelMenuError = ''
        this.Shared.note.db.updateKey({ labels: this.labels })
        return
      }
      this.labelMenuError = error?.status === 409 ? 'Label already exists' : 'Could not create label'
    }
  }

  async openCollaboratorMenu(button: HTMLDivElement, tooltipEl: HTMLDivElement, note: NoteI) {
    this.Shared.note.id = note.id!
    this.Ttbutton = button
    this.collaboratorNote = note
    this.collaboratorError = ''
    this.collaboratorUsers = []
    this.selectedCollaboratorIds = (note.collaborators || []).map(user => user.id)
    this.Shared.createTooltip(button, tooltipEl)

    try {
      this.collaboratorUsers = await this.Shared.note.db.listShareUsers()
      if (this.canManageCollaborators()) {
        const collaborators = await this.notesService.getCollaborators(note.id!)
        this.selectedCollaboratorIds = collaborators.map(user => user.id)
      }
    } catch (error: any) {
      this.collaboratorError = error?.error?.error || 'Could not load sharing options.'
    }
  }

  canManageCollaborators() {
    return !!this.collaboratorNote?.id && this.collaboratorNote.ownerUserId === this.auth.currentUser?.id
  }

  isNoteOwner(userId: number) {
    return !!this.collaboratorNote?.ownerUserId && this.collaboratorNote.ownerUserId === userId
  }

  isCollaboratorSelected(userId: number) {
    return this.selectedCollaboratorIds.includes(userId)
  }

  async toggleCollaborator(userId: number) {
    if (!this.canManageCollaborators()) return
    if (this.isCollaboratorSelected(userId)) {
      this.selectedCollaboratorIds = this.selectedCollaboratorIds.filter(id => id !== userId)
    } else {
      this.selectedCollaboratorIds = [...this.selectedCollaboratorIds, userId]
    }
    // Auto-save
    try {
      const noteId = this.collaboratorNote?.id
      if (!noteId) return
      const collaborators = await this.notesService.updateCollaborators(noteId, this.selectedCollaboratorIds)
      if (this.activeNote) this.activeNote.collaborators = collaborators
      if (this.collaboratorNote) this.collaboratorNote.collaborators = collaborators
    } catch (error: any) {
      this.collaboratorError = error?.error?.error || 'Could not update collaborators.'
    }
  }

  async saveCollaborators(tooltipEl: HTMLDivElement) {
    if (!this.canManageCollaborators()) return
    this.isSavingCollaborators = true
    this.collaboratorError = ''
    try {
      const noteId = this.collaboratorNote?.id
      if (!noteId) return
      const collaborators = await this.notesService.updateCollaborators(noteId, this.selectedCollaboratorIds)
      if (this.activeNote) this.activeNote.collaborators = collaborators
      if (this.collaboratorNote) this.collaboratorNote.collaborators = collaborators
      this.Shared.closeTooltip(tooltipEl)
    } catch (error: any) {
      this.collaboratorError = error?.error?.error || 'Could not save collaborators.'
    } finally {
      this.isSavingCollaborators = false
    }
  }

  // ? archive page

  toggleArchive(noteId: number, archived: boolean) {
    this.Shared.note.id = noteId
    archived = !archived
    this.Shared.note.db.updateKey({ archived: archived, trashed: false })
    let obj = archived ? { action: 'archived', opposite: 'unarchived' } : { action: 'unarchived', opposite: 'archived' }
    this.Shared.snackBar(obj, { archived: !archived }, noteId)
  }

  // ? trash page

  removeNote(note: NoteI) {
    if (note.ownerUserId && note.ownerUserId !== this.auth.currentUser?.id) {
      this.Shared.snackBar({ action: 'Only the owner of this note can delete it forever.', opposite: '' }, {}, 0)
      return
    }
    if (!note.id || this.pendingPermanentDeletes.has(note.id)) return
    const noteId = note.id
    const pending = {
      note,
      allIndex: this.Shared.note.all.findIndex(n => n.id === noteId),
      pinnedIndex: this.Shared.note.pinned.findIndex(n => n.id === noteId),
      unpinnedIndex: this.Shared.note.unpinned.findIndex(n => n.id === noteId),
      timer: setTimeout(() => {
        this.pendingPermanentDeletes.delete(noteId)
        this.notesService.delete(noteId)
      }, 5000)
    }
    this.pendingPermanentDeletes.set(noteId, pending)
    this.removePendingDeletedNoteFromView(noteId)
    Snackbar.show({
      pos: 'bottom-left',
      text: 'Note deleted',
      actionText: 'Undo',
      duration: 4200,
      onActionClick: () => {
        const current = this.pendingPermanentDeletes.get(noteId)
        if (!current) return
        clearTimeout(current.timer)
        this.pendingPermanentDeletes.delete(noteId)
        this.restorePendingDeletedNoteToView(current)
        Snackbar.show({
          pos: 'bottom-left',
          text: 'Note restored',
          duration: 3000,
        })
      }
    })
  }

  private removePendingDeletedNoteFromView(noteId: number) {
    this.Shared.note.all = this.Shared.note.all.filter(n => n.id !== noteId)
    this.Shared.note.pinned = this.Shared.note.pinned.filter(n => n.id !== noteId)
    this.Shared.note.unpinned = this.Shared.note.unpinned.filter(n => n.id !== noteId)
    this.masonrySignatureToken++
    this.cd.detectChanges()
    this.scheduleBuildMasonry(true)
  }

  private restorePendingDeletedNoteToView(pending: { note: NoteI; allIndex: number; pinnedIndex: number; unpinnedIndex: number }) {
    this.Shared.note.all = this.insertNoteAt(this.Shared.note.all, pending.note, pending.allIndex)
    if (pending.note.pinned) {
      this.Shared.note.pinned = this.insertNoteAt(this.Shared.note.pinned, pending.note, pending.pinnedIndex)
    } else {
      this.Shared.note.unpinned = this.insertNoteAt(this.Shared.note.unpinned, pending.note, pending.unpinnedIndex)
    }
    this.masonrySignatureToken++
    this.cd.detectChanges()
    this.scheduleBuildMasonry(true)
  }

  private insertNoteAt(notes: NoteI[], note: NoteI, index: number) {
    const next = notes.filter(n => n.id !== note.id)
    const safeIndex = index >= 0 ? Math.min(index, next.length) : next.length
    next.splice(safeIndex, 0, note)
    return next
  }

  restoreNote(noteId: number) {
    this.Shared.note.id = noteId
    this.Shared.note.db.updateKey({ trashed: false, archived: false })
    this.Shared.snackBar({ action: 'restored', opposite: 'trashed' }, { trashed: true }, noteId)
  }
  // ? reminder picker -----------------------------------------------

  getActiveReminderForNote(noteId: number) {
    const reminders = this.reminderService.reminders$.value
    if (!this.reminderLookupCache || this.reminderLookupCache.reminders !== reminders) {
      const byNoteId = new Map<number, any>()
      reminders
        .filter(reminder => reminder.status === 'pending' && reminder.noteId)
        .forEach(reminder => byNoteId.set(reminder.noteId!, reminder))
      this.reminderLookupCache = { reminders, byNoteId }
    }
    return this.reminderLookupCache.byNoteId.get(noteId)
  }

  toggleReminderPicker(note: NoteI, event: Event) {
    event.stopPropagation()

    // iOS Safari requires Notification.requestPermission() to be called
    // synchronously inside a user gesture. Fire it on this tap — same
    // gesture window in which the overlaid <input type="date"> beneath us
    // will trigger the system date picker.
    this.promptForNotificationPermission()

    // If the note already has a reminder, toggle the inline "Remove reminder"
    // panel. When no reminder exists, the transparent date input overlaid
    // on the alarm icon receives the same tap and the OS opens its native
    // date picker — see noteTemplate in notes.component.html.
    if (this.getActiveReminderForNote(note.id!)) {
      if (this.activePickerNoteId === note.id) {
        this.closeReminderPicker()
      } else {
        this.activePickerNoteId = note.id!
        document.removeEventListener('mousedown', this.pickerOutsideHandler)
        setTimeout(() => document.addEventListener('mousedown', this.pickerOutsideHandler), 0)
      }
    } else {
      this.pendingPickerNote = note
      this.activePickerNoteId = note.id!
      this.customDate = ''
      this.customTime = ''
      this.calendarMonth = this.startOfMonth(new Date())
      this.destroyTimePicker()
      document.removeEventListener('mousedown', this.pickerOutsideHandler)
      setTimeout(() => document.addEventListener('mousedown', this.pickerOutsideHandler), 0)
    }
  }

  // Per-note pending date confirmation. After the user picks a date on
  // the overlaid date input, we surface an inline pill with the chosen
  // date + a "Pick time" button. The user explicitly confirms — this
  // avoids iOS Safari auto-committing the wheel's default value when the
  // user just dismisses the picker.
  pendingNoteDateConfirm: { note: NoteI; date: string; dateInput: HTMLInputElement } | null = null

  onNoteAlarmDateChange(note: NoteI, event: Event) {
    const input = event.target as HTMLInputElement
    if (!input?.value) {
      if (this.pendingNoteDateConfirm?.note.id === note.id) {
        this.pendingNoteDateConfirm = null
      }
      return
    }
    this.pendingPickerNote = note
    this.activePickerNoteId = note.id!
    this.customDate = input.value
    this.pendingNoteDateConfirm = { note, date: input.value, dateInput: input }
  }

  confirmPendingNoteDate() {
    const p = this.pendingNoteDateConfirm
    if (!p) return
    this.pendingNoteDateConfirm = null
    const timeInput = this.globalReminderTime?.nativeElement
    if (!timeInput) return
    setTimeout(() => this.openGlobalTimePicker(p.note, p.dateInput, timeInput), 50)
  }

  cancelPendingNoteDate() {
    if (this.pendingNoteDateConfirm) {
      this.pendingNoteDateConfirm.dateInput.value = ''
    }
    this.pendingNoteDateConfirm = null
    this.customDate = ''
    this.activePickerNoteId = null
    this.pendingPickerNote = null
  }

  formatPendingDateLabel(iso: string): string {
    if (!iso) return ''
    const [y, m, d] = iso.split('-').map(Number)
    if (!y || !m || !d) return iso
    const date = new Date(y, m - 1, d)
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  }

  todayDateInput() {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    return this.formatLocalDateInput(date)
  }

  private formatLocalDateInput(date: Date) {
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }

  calendarMonthLabel() {
    return this.calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }

  calendarDays() {
    const month = this.calendarMonth.getMonth()
    const year = this.calendarMonth.getFullYear()
    const first = new Date(year, month, 1)
    const start = new Date(first)
    start.setDate(1 - first.getDay())
    const today = this.todayDateInput()
    const selected = this.customDate

    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start)
      date.setDate(start.getDate() + index)
      const iso = this.formatLocalDateInput(date)
      return {
        date: iso,
        day: date.getDate(),
        currentMonth: date.getMonth() === month,
        disabled: iso < today,
        selected: iso === selected,
        today: iso === today
      }
    })
  }

  shiftCalendarMonth(delta: number) {
    const next = new Date(this.calendarMonth)
    next.setMonth(next.getMonth() + delta)
    this.calendarMonth = this.startOfMonth(next)
  }

  selectCalendarDate(date: string) {
    if (date < this.todayDateInput()) return
    this.customDate = date
  }

  private startOfMonth(date: Date) {
    return new Date(date.getFullYear(), date.getMonth(), 1)
  }

  confirmNoteDate(note: NoteI) {
    if (!this.customDate) return
    this.pendingPickerNote = note
    const timeInput = this.globalReminderTime?.nativeElement
    if (!timeInput) return
    this.openGlobalTimePicker(note, null, timeInput)
  }

  private openGlobalTimePicker(note: NoteI, dateInput: HTMLInputElement | null, timeInput: HTMLInputElement) {
    this.createTimePicker(note, dateInput, timeInput)
    this.customTimePicker?.open()
  }

  closeReminderPicker() {
    this.activePickerNoteId = null
    this.pendingPickerNote = null
    this.destroyTimePicker()
    document.removeEventListener('mousedown', this.pickerOutsideHandler)
  }

  // Synchronous-from-gesture permission request. iOS Safari refuses to show
  // the prompt unless Notification.requestPermission() is invoked directly
  // in a user gesture, so this MUST not await anything before the call.
  private promptForNotificationPermission() {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'granted') {
      this.reminderService.requestBrowserNotifications()
      return
    }
    if (Notification.permission === 'denied') {
      try {
        (window as any).Snackbar?.show({
          pos: 'bottom-left',
          text: 'Notifications are blocked. Enable them in Settings → Notifications → Kept.',
          duration: 5000
        })
      } catch {}
      return
    }
    if (this.reminderService.isIos() && !this.reminderService.isStandalone()) {
      try {
        (window as any).Snackbar?.show({
          pos: 'bottom-left',
          text: 'On iOS, open Kept from the Home Screen icon to enable reminders. (Safari tabs cannot register notifications.)',
          duration: 6000
        })
      } catch {}
      return
    }
    // Direct, synchronous call into the gesture. The returned promise is
    // intentionally not awaited here so we don't tie the caller's gesture
    // to its resolution. ensureSubscribed runs after the user decides.
    const result = Notification.requestPermission()
    if (result && typeof result.then === 'function') {
      result.then(permission => {
        if (permission === 'granted') {
          this.reminderService.requestBrowserNotifications()
        }
      }).catch(() => {})
    }
  }

  private pickerOutsideHandler = (event: Event) => {
    const target = event.target as HTMLElement
    const picker = document.querySelector('.reminder-picker')
    const isTimePickerClick = target.closest('.tp-ui-modal') || target.closest('.tp-ui-wrapper')
    if (picker && !picker.contains(target) && !isTimePickerClick) {
      this.closeReminderPicker()
    }
  }

  async setReminder(date: Date, note: NoteI) {
    // Permission was already prompted synchronously when the picker opened
    // (toggleReminderPicker → promptForNotificationPermission). Re-prompt
    // here as a backup for users who jumped straight to a custom date input.
    this.promptForNotificationPermission()
    const existing = note.id ? this.getActiveReminderForNote(note.id) : undefined
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (existing) {
      await this.reminderService.update(existing.id, { dueAtUtc: date.toISOString(), status: 'pending' })
    } else {
      await this.reminderService.create({
        noteId: note.id,
        dueAtUtc: date.toISOString(),
        timezone: tz,
        title: this.notePlainText(note.noteTitle) || undefined,
        body: this.notePlainText(note.noteBody) || undefined,
        imageUrl: this.firstNoteImageUrl(note) || undefined
      })
    }
    this.closeReminderPicker()
  }

  confirmCustom(note: NoteI, dateInp: HTMLInputElement | null, timeInp: HTMLInputElement) {
    const d = dateInp?.value || this.customDate
    const t = this.toTwentyFourHourTime(timeInp.value || this.customTime)
    if (!d || !t) return
    // Close synchronously so the picker always disappears regardless of API outcome
    this.closeReminderPicker()
    this.customPickerOpen = false
    this.setReminder(new Date(`${d}T${t}`), note)
  }

  private createTimePicker(note: NoteI | null, dateInput: HTMLInputElement | null, timeInput: HTMLInputElement) {
    if (this.customTimePicker && this.customTimePickerInput === timeInput) {
      this.timePickerNote = note || this.timePickerNote
      this.timePickerDateInput = dateInput || this.timePickerDateInput
      return
    }
    this.destroyTimePicker()
    this.timePickerNote = note || undefined
    this.timePickerDateInput = dateInput || undefined
    this.customTimePickerInput = timeInput
    timeInput.value = this.customTime || this.currentTimeValue()
    this.customTimePicker = new TimepickerUI(timeInput, {
      clock: {
        currentTime: { time: new Date(), updateInput: true }
      },
      ui: {
        editable: true
      },
      callbacks: {
        onOpen: () => {
          this.bindTimePickerPadding()
        },
        onUpdate: () => setTimeout(() => this.padTimePickerFields(), 0),

        onConfirm: (data: ConfirmEventData) => {
          this.zone.run(() => {
            const hour = String(data.hour || '').padStart(2, '0')
            const minutes = String(data.minutes || '').padStart(2, '0')
            const period = data.type ? ` ${data.type}` : ''
            this.customTime = `${hour}:${minutes}${period}`
            if (this.timePickerNote && (this.timePickerDateInput?.value || this.customDate)) {
              setTimeout(() => this.confirmCustom(this.timePickerNote!, this.timePickerDateInput || null, timeInput), 0)
            }
          })
        }
      }
    })
    this.customTimePicker.create()
  }

  private destroyTimePicker() {
    this.unbindTimePickerPadding()
    this.customTimePicker?.destroy({ keepInputValue: true })
    this.customTimePicker = undefined
    this.customTimePickerInput = undefined
    this.timePickerNote = undefined
    this.timePickerDateInput = undefined
  }

  private toTwentyFourHourTime(value: string) {
    const time = value.trim().toUpperCase()
    const twelveHour = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/)
    if (twelveHour) {
      let hour = Number(twelveHour[1])
      if (twelveHour[3] === 'PM' && hour < 12) hour += 12
      if (twelveHour[3] === 'AM' && hour === 12) hour = 0
      return `${String(hour).padStart(2, '0')}:${twelveHour[2]}`
    }
    const twentyFourHour = time.match(/^(\d{1,2}):(\d{2})$/)
    if (!twentyFourHour) return ''
    const hour = Number(twentyFourHour[1])
    if (hour > 23 || Number(twentyFourHour[2]) > 59) return ''
    return `${String(hour).padStart(2, '0')}:${twentyFourHour[2]}`
  }

  private notePlainText(value?: string | null) {
    const div = document.createElement('div')
    div.innerHTML = value || ''
    return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim()
  }

  private firstNoteImageUrl(note: NoteI) {
    const attachedImage = note.images?.[0]?.dataUrl
    if (attachedImage) return this.auth.authenticatedImageUrl(attachedImage)

    const match = (note.noteBody || '').match(/<img[^>]+src=["']([^"']+)["']/i)
    return match?.[1] ? this.auth.authenticatedImageUrl(match[1]) : ''
  }

  private timePickerInputHandler = () => {
    setTimeout(() => this.padTimePickerFields(), 0)
  }

  private bindTimePickerPadding() {
    const fields = document.querySelectorAll<HTMLInputElement>('.tp-ui-hour, .tp-ui-minutes')
    fields.forEach(field => {
      field.removeEventListener('input', this.timePickerInputHandler)
      field.addEventListener('input', this.timePickerInputHandler)
    })
    this.padTimePickerFields()
  }

  private unbindTimePickerPadding() {
    const fields = document.querySelectorAll<HTMLInputElement>('.tp-ui-hour, .tp-ui-minutes')
    fields.forEach(field => field.removeEventListener('input', this.timePickerInputHandler))
  }

  private padTimePickerFields() {
    const fields = document.querySelectorAll<HTMLInputElement>('.tp-ui-hour, .tp-ui-minutes')
    fields.forEach(field => {
      if (!field.value) return
      field.value = String(Number(field.value)).padStart(2, '0')
    })
  }

  private currentTimeValue() {
    return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  fireDebugReminder(note: NoteI, event: Event) {
    event.stopPropagation()
    this.reminderService.debugFireReminder(
      this.notePlainText(note.noteTitle) || 'Debug reminder',
      this.notePlainText(note.noteBody) || 'Manual reminder test.'
    )
  }

  async clearReminder(note: NoteI, event: Event) {
    event.stopPropagation()
    const existing = note.id ? this.getActiveReminderForNote(note.id) : undefined
    if (existing) await this.reminderService.delete(existing.id)
    this.closeReminderPicker()
  }

  inHours(n: number): Date {
    return new Date(Date.now() + n * 60 * 60 * 1000)
  }

  tomorrow(): Date {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d
  }

  nextWeek(): Date {
    const d = new Date()
    const daysUntilMonday = ((8 - d.getDay()) % 7) || 7
    d.setDate(d.getDate() + daysUntilMonday)
    d.setHours(9, 0, 0, 0)
    return d
  }

  formatPickerDate(date: Date): string {
    return date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  formatReminderDate(isoString: string): string {
    const cached = this.reminderDateCache.get(isoString)
    if (cached) return cached
    const formatted = new Date(isoString).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    this.reminderDateCache.set(isoString, formatted)
    return formatted
  }

  // ?--------------------------------------------------------------

  ngAfterViewChecked() {
    const renderContext = `${this.currentPageName}:${this.Shared.searchQuery}:${this.Shared.noteViewType.value}`
    if (renderContext !== this.lastRenderContext) {
      this.lastRenderContext = renderContext
      if (this.isSearchActive()) {
        this.visibleNoteLimit = Math.max(this.initialNoteRenderChunk, this.pageNotes().length)
        this.didInitialExpand = true
        this.suppressScrollPaginationUntil = Date.now() + 350
        window.scrollTo({ top: 0 })
        this.settleSearchResultsLayout()
      } else {
        // Reset to the small initial chunk so the new context paints fast.
        this.visibleNoteLimit = this.initialNoteRenderChunk
        this.didInitialExpand = false
      }
    }
    // After the small chunk has actually painted (two animation frames so the
    // browser commits paint, then idle / timeout fallback so we don't add
    // another 56 notes to the same render cycle), grow the visible window in
    // staircases. Each step is one CD pass and one paint, so the user sees
    // notes streaming in instead of waiting for a giant single render.
    if (!this.didInitialExpand && this.Shared.note.all.length > this.visibleNoteLimit) {
      this.didInitialExpand = true
      this.scheduleProgressiveExpand()
    }
    this.maybeBackfillFilteredPage()
    this.observeLoadMoreSentinelIfNeeded()
    this.scheduleBuildMasonry()
    this.queueKeptAppReadySignal()
  }

  private queueKeptAppReadySignal() {
    if (this.keptAppReadySent || this.keptAppReadyQueued) return
    if (!this.notesService.hasLoaded || this.notesService.loading) return

    this.keptAppReadyQueued = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.keptAppReadyQueued = false
      if (this.trySignalKeptAppReady('notes-rendered')) return

      if (this.keptAppReadyRetry) clearTimeout(this.keptAppReadyRetry)
      this.keptAppReadyRetry = setTimeout(() => {
        this.keptAppReadyRetry = undefined
        this.trySignalKeptAppReady('notes-rendered-retry')
      }, 80)
    }))
  }

  private trySignalKeptAppReady(reason: string) {
    if (this.keptAppReadySent) return true
    if (!this.notesService.hasLoaded || this.notesService.loading) return false

    const hasRenderableNotesState = !!document.querySelector('.note-container, .no-notes')
    if (!hasRenderableNotesState) return false

    this.keptAppReadySent = true
    const payload = {
      ready: true,
      reason: 'angular-ready'
    }

    try {
      ;(window as any).webkit?.messageHandlers?.keptAppReady?.postMessage(payload)
    } catch (error) {
      console.warn('[Kept] keptAppReady native signal failed', error)
    }

    try {
      window.dispatchEvent(new CustomEvent('kept-app-ready', { detail: payload }))
    } catch {}

    return true
  }

  private scheduleProgressiveExpand() {
    const target = Math.min(this.Shared.note.all.length, this.noteRenderChunk * 2)
    const step = 32
    const tick = () => {
      if (this.visibleNoteLimit >= target) return
      // Two rAFs ensures the previous chunk's layout and paint committed
      // before we add more, so each step is visible.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        this.zone.run(() => {
          this.visibleNoteLimit = Math.min(this.visibleNoteLimit + step, target)
        })
        if (this.visibleNoteLimit < target) tick()
      }))
    }
    tick()
  }

  @HostListener('window:resize')
  onResize() {
    this.scheduleBuildMasonry(true)
  }

  ngOnInit(): void {
    this.syncCurrentPage(this.router.url)
    window.addEventListener('kept-smart-capture-notes-added', this.smartCaptureNotesAddedHandler)
    this.subscriptions.push(
      this.Shared.closeSideBar.subscribe(() => { setTimeout(() => { this.scheduleBuildMasonry(true) }, 200) }),
      this.Shared.closeModal.subscribe(x => { if (x) this.closeModal() }),
      this.Shared.noteViewType.subscribe(() => {
        setTimeout(() => this.scheduleBuildMasonry(true), 300);
        this.scheduleIPadMasonrySettle()
      }),
      this.notesService.notesList$.subscribe(notes => {
        this.masonrySignatureToken++
        this.lastBackfillContext = ''
        this.settleSearchResultsLayout()
        this.settleSmartCaptureResultsLayout(notes)
      }),
      this.reminderService.reminders$.subscribe(() => { this.masonrySignatureToken++ }),
      this.router.events.subscribe(url => {
        if (url instanceof NavigationEnd) {
          const currentUrl = url.urlAfterRedirects || url.url
          this.syncCurrentPage(currentUrl)
          this.Shared.clearNoteSelection()
          if (window.innerWidth >= 600) {
            requestAnimationFrame(() => window.scrollTo({ top: 0 }))
          }
        }
        else if (url instanceof ActivationEnd && url.snapshot.params['name']) {
          this.currentPage.label = url.snapshot.params['name']
          this.updateCurrentPageName()
        }
      })
    )
  }

  ngAfterViewInit() {
    if (!('IntersectionObserver' in window)) return
    this.loadMoreObserver = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      this.zone.run(() => {
        if (this.hasMoreServerNotes()) this.loadMoreNotesIfNeeded()
        else this.increaseVisibleNoteLimit()
      })
    }, { root: null, rootMargin: '70% 0px', threshold: 0 })
    setTimeout(() => {
      this.observeLoadMoreSentinelIfNeeded()
    })
  }

  ngOnDestroy(): void {
    window.removeEventListener('kept-smart-capture-notes-added', this.smartCaptureNotesAddedHandler)
    this.loadMoreObserver?.disconnect()
    if (this.keptAppReadyRetry) clearTimeout(this.keptAppReadyRetry)
    this.clearModalScrollRestoreTimers()
    this.closeReminderPicker()
    this.subscriptions.forEach(s => s.unsubscribe())
    this.subscriptions = []
  }

  deleteImage(note: NoteI, image: any, event: Event) {
    event.stopPropagation()
    this.notesService.deleteImage(note, image)
  }

  async downloadAttachment(attachment: NoteAttachmentI, event: Event) {
    event.stopPropagation()
    try {
      await this.notesService.downloadAttachment(attachment)
    } catch (error: any) {
      this.showMessage(error?.error?.error || 'Could not download attachment.')
    }
  }

  attachmentIcon(attachment: NoteAttachmentI) {
    const ext = attachment.originalName.split('.').pop()?.toLowerCase() || ''
    if (attachment.mimeType.startsWith('image/')) return 'image'
    if (attachment.mimeType.includes('pdf')) return 'picture_as_pdf'
    if (['txt', 'md', 'csv', 'json', 'xml'].includes(ext)) return 'description'
    if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'folder_zip'
    if (['xls', 'xlsx', 'ods'].includes(ext)) return 'table_chart'
    if (['ppt', 'pptx', 'odp'].includes(ext)) return 'slideshow'
    return 'draft'
  }

  formatFileSize(size: number) {
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
    return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`
  }

  private showMessage(message: string) {
    try {
      Snackbar.show({ pos: 'bottom-left', text: message, duration: 3600 })
    } catch {}
  }
}
