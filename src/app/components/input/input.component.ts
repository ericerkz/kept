import { NoteI, CheckboxI, NoteImageI, NoteAttachmentI } from '../../interfaces/notes';
import { Component, OnInit, ViewChild, ElementRef, ChangeDetectorRef, Input, HostBinding, HostListener } from '@angular/core';

import { bgImages, bgColors } from 'src/app/interfaces/tooltip';
import { SharedService } from 'src/app/services/shared.service';
import { BehaviorSubject, Subscription, Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { LabelI } from 'src/app/interfaces/labels';
import { AuthService } from 'src/app/services/auth.service';
import { ShareUserI } from 'src/app/interfaces/users';
import { LinkPreviewData, NotesService } from 'src/app/services/notes.service';
import { PushNotificationService } from 'src/app/services/push-notification.service';
import { ReminderService } from 'src/app/services/reminder.service';
import { KeptPluginsService, type ResolvedLocation } from 'src/app/services/kept-plugins.service';
import { LocationSavedPlacesService, type LocationSavedPlace, type LocationTrigger, type SavedPlaceType } from 'src/app/services/location-saved-places.service';
import { NgZone } from '@angular/core';
import { TimepickerUI, type ConfirmEventData } from 'timepicker-ui';

declare var Snackbar: any;
type InputLengthI = { title?: number, body?: number, cb?: number }
type DrawingTool = 'select' | 'pen' | 'marker' | 'highlighter' | 'eraser'
type DrawingPoint = { x: number, y: number }
type DrawingSelection = { x: number, y: number, w: number, h: number }
type PlaceDialogView = 'choose' | 'manage' | 'add' | 'search'
type PlaceListItem = LocationSavedPlace | { id: 'home-prompt' | 'work-prompt'; name: string; address: string; placeType: SavedPlaceType; prompt: true }
@Component({
    selector: 'app-input',
    templateUrl: './input.component.html',
    styleUrls: ['./input.component.scss'],
    standalone: false
})
export class InputComponent implements OnInit {
  @HostBinding('class.mobile-active') get isMobileActive() {
    return this.mobileComposeMode;
  }

  constructor(private cd: ChangeDetectorRef, public Shared: SharedService, public auth: AuthService, private notesService: NotesService, private push: PushNotificationService, private reminderService: ReminderService, public keptPlugins: KeptPluginsService, private savedPlacesService: LocationSavedPlacesService, private zone: NgZone) { }

  @ViewChild("main") main!: ElementRef<HTMLDivElement>
  //? Placeholder  ----------------------------------------------------
  @ViewChild("notePlaceholder") notePlaceholder!: ElementRef<HTMLDivElement>
  //? note  -----------------------------------------------------
  @ViewChild("noteMain") noteMain!: ElementRef<HTMLDivElement>
  @ViewChild("noteContainer") noteContainer!: ElementRef<HTMLDivElement>
  @ViewChild("noteTitle") noteTitle!: ElementRef<HTMLDivElement>
  @ViewChild("noteBody") noteBody?: ElementRef<HTMLDivElement>
  @ViewChild("notePin") notePin!: ElementRef<HTMLDivElement>
  @ViewChild("imageInput") imageInput!: ElementRef<HTMLInputElement>
  @ViewChild("attachmentInput") attachmentInput!: ElementRef<HTMLInputElement>
  @ViewChild("drawingCanvas") drawingCanvas?: ElementRef<HTMLCanvasElement>
  @ViewChild("drawingWrap") drawingWrap?: ElementRef<HTMLDivElement>
  //? checkbox  -----------------------------------------------------
  @ViewChild("cboxInput") cboxInput!: ElementRef<HTMLDivElement>
  @ViewChild("cboxPh") cboxPh?: ElementRef<HTMLDivElement>
  @ViewChild("moreMenuTtBtn") moreMenuTtBtn?: ElementRef<HTMLDivElement> // needed in the html
  //? -----------------------------------------------------
  @Input() isEditing = false
  @Input() noteToEdit: NoteI = {} as NoteI
  @Input() autoOpenImagePicker = false
  //? -----------------------------------------------------
  checkBoxes: CheckboxI[] = []
  images: NoteImageI[] = []
  attachments: NoteAttachmentI[] = []
  pendingAttachmentFiles: File[] = []
  isUploadingAttachment = false
  readonly attachmentAccept = [
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.txt', '.csv', '.md', '.json', '.xml',
    '.zip', '.rar', '.7z', '.gz', '.tar',
    '.odt', '.ods', '.odp'
  ].join(',')
  labels: LabelI[] = []
  private labelsDirty = false
  isArchived = false
  isTrashed = false
  isCboxCompletedListCollapsed = false
  showTextFormatting = false
  isCbox = new BehaviorSubject<boolean>(false)
  inputLength = new BehaviorSubject<InputLengthI>({ title: 0, body: 0, cb: 0 })
  collaboratorUsers: ShareUserI[] = []
  selectedCollaboratorIds: number[] = []
  
  // Reminder State
  showReminderPicker = false
  customPickerOpen = false
  customDate = ''
  customTime = ''
  readonly calendarWeekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  calendarMonth = this.startOfMonth(new Date())
  customTimePicker: any
  customTimePickerInput?: HTMLInputElement
  pendingReminderDate: Date | null = null
  pendingReminderLocation: { locationName: string; latitude: number; longitude: number; radiusMeters: number; timezone: string; locationTrigger: LocationTrigger } | null = null
  showReminderTypeDialog = false
  showReminderDateDialog = false
  showReminderLocationDialog = false
  placeDialogView: PlaceDialogView = 'choose'
  locationState: 'idle' | 'resolved' | 'ambiguous' | 'permission' | 'notFound' = 'idle'
  locationPhrase = ''
  resolvedLocation: ResolvedLocation | null = null
  locationMapPreview = ''
  candidates: ResolvedLocation[] = []
  resolving = false
  permissionReason = ''
  showAndroidBackgroundLocationEducation = false
  androidBackgroundLocationMessage = ''
  savedPlaces: LocationSavedPlace[] = []
  savedPlacesLoading = false
  savedPlacesError = ''
  savedPlacesSearch = ''
  locationTrigger: LocationTrigger = 'arrive'
  addPlaceName = ''
  addPlaceType: SavedPlaceType = 'other'
  addPlaceRadiusMeters = 100
  addPlaceSaving = false
  swipingPlaceId: number | null = null
  readonly savedPlaceTypes: SavedPlaceType[] = ['home', 'work', 'gym', 'other']
  readonly savedPlaceRadii = [100, 250, 500, 1000]
  currentLocation: { latitude: number; longitude: number } | null = null
  currentLocationLoading = false
  private placeSwipeStartPoint?: { id: number; x: number; y: number }
  private pendingAndroidLocationReminder: { location: ResolvedLocation; trigger: LocationTrigger } | null = null
  private androidBackgroundLocationResumeHandler?: () => void
  private androidBackgroundLocationFocusHandler?: () => void
  private androidBackgroundLocationResumeRunning = false
  collaboratorError = ''
  isSavingCollaborators = false
  labelMenuError = ''
  hasBackgroundImage = false
  isDrawingNote = false
  isDrawingFullscreen = false
  // Set true when the loaded note has both a body and a checklist (hybrid note,
  // typically from a merge). Latches for the session so the body stays
  // visible even if the user momentarily clears it while editing.
  isHybridNote = false
  drawingTool: DrawingTool = 'pen'
  drawingBackground: 'square' | 'dots' | 'rules' | 'none' = 'rules'
  showDrawingBackgroundMenu = false
  showDrawingMoreMenu = false
  showDrawingEraserMenu = false
  drawingOpenToolMenu?: 'pen' | 'marker' | 'highlighter'
  drawingColors = ['#000000', '#ff4b55', '#ffb52e', '#20bf55', '#26a7df', '#bd10e0', '#8d6e63', '#ffffff', '#b3261e', '#f57c00', '#558b2f', '#0b5c99', '#8e24aa', '#4e342e', '#9eb0b9', '#f5367a', '#ff674d', '#aeea00', '#3454f4', '#6f4df6', '#35d7b7', '#d5e1e5', '#f8b5cf', '#ffc8b8', '#eef4bd', '#a8b7e8', '#d1c4e9', '#b2dfdb']
  drawingSizes = [2, 4, 7, 10, 14, 19, 25]
  drawingToolOptions = {
    pen: { color: '#202124', size: 4 },
    marker: { color: '#ff4b55', size: 7 },
    highlighter: { color: '#fbbc04', size: 19 }
  }
  drawingSelection?: DrawingSelection
  drawingSelectionStyle: Record<string, string> = {}
  drawingHistory: string[] = []
  drawingHistoryIndex = -1
  private isDrawing = false
  private drawingLastPoint?: DrawingPoint
  private drawingResize?: ResizeObserver
  private drawingSelectionStart?: DrawingPoint
  private movingSelection?: { canvas: HTMLCanvasElement, offset: DrawingPoint, lastRect: DrawingSelection, handle?: string, aspectRatio?: number, fixedPoint?: DrawingPoint }
  draggedInlineImage?: HTMLElement
  draggedInlineObject?: HTMLElement
  draggedCboxId?: number;
  dragReadyCboxId?: number;
  cboxDragOrderChanged = false;
  cboxDragImage?: HTMLElement;
  cboxDragImageOffset = { x: 0, y: 0 };
  private cboxTouchTimer?: ReturnType<typeof setTimeout>;
  private cboxTouchDragging = false;
  private cboxTouchIsDone = false;
  private cboxTouchStartX = 0;
  private cboxTouchStartY = 0;
  private lastCboxTouchToggleAt = 0;
  activePointers: Map<number, { x: number, y: number }> = new Map();
  drawingTransform = { scale: 1, x: 0, y: 0 };
  private isPanning = false;
  private initialPinchDistance?: number;
  private initialPinchScale?: number;
  private initialPinchMidpoint?: DrawingPoint;
  private initialPinchTranslate?: { x: number, y: number };
  activeEditors: any[] = [];
  autoSaveSubject = new Subject<void>();
  autoSaveSubscription?: Subscription;
  coEditSubscription?: Subscription;
  notesListSubscription?: Subscription;
  mobileComposerSubscription?: Subscription;
  private coEditSaveInFlight = false;
  private coEditSaveQueued = false;
  private lastBodyRange?: Range
  private destroyed = false
  private editorPreviewGeneration = 0
  private editorLinkDecorationFrame?: number
  private saveBaselineSnapshot?: string
  mobileComposeMode = false
  lastEditedTime = ''
  //
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
  moreMenuEls = {
    delete: {
      disabled: true,
    },
    copy: {
      disabled: true,
    },
    checkbox: {
      value: 'Show checkboxes'
    },
  }
  //? placeholder  --------------------------------------------------

  toggleNoteVisibility(condition: boolean) {
    if (condition) {
      this.notePlaceholder.nativeElement.hidden = true; this.noteMain.nativeElement.hidden = false
    } else {
      this.notePlaceholder.nativeElement.hidden = false; this.noteMain.nativeElement.hidden = true
    }
  }

  notePhClick() {
    this.toggleNoteVisibility(true)
    if (this.isCbox.value) this.cboxPh?.nativeElement.focus()
    else this.noteBody?.nativeElement.focus()
    if (!this.isEditing) {
      this.inputLength.next({ title: 0, body: 0, cb: 0 })
      document.addEventListener('mousedown', this.mouseDownEvent)
    }
    this.labels = JSON.parse(JSON.stringify(this.Shared.label.list))
    this.labelsDirty = false
    /*
    the correct way is to use `mousedown` because : 
    https://www.javascripttutorial.net/javascript-dom/javascript-mouse-events/
    click & mouseup, wont get the job done.
    when u try to select a text, and you loose the click btn outside `notesContainer`,
    `closeNote()` will be called
    https://prnt.sc/Wu_19wKRAYig
    */
  }

  mouseDownEvent = async (event: Event) => {
    if (this.isEditing) return
    const el = this.main.nativeElement
    const target = event.target as HTMLElement
    
    // Check for open tooltips or pickers
    const isTooltipOpen = !!document.querySelector('[data-is-tooltip-open="true"]')
    const isPickerClick = !!target.closest('.reminder-picker') || 
                          !!target.closest('.tp-ui-modal') || 
                          !!target.closest('.tp-ui-wrapper')
    const isInsideNote = el.contains(target)
    
    // Special check for elements outside app-root (like TimepickerUI modals)
    const appRoot = document.querySelector('app-root')
    const isOutsideApp = appRoot && !appRoot.contains(target)

    // If clicking inside the note, an open tooltip, our pickers, or outside the app (modals), DO NOT close.
    if (isInsideNote || isTooltipOpen || isPickerClick || isOutsideApp) {
      return
    }

    // Otherwise, save and close
    await this.saveNote()
    this.closeNote()
  }

  closeNote() {
    this.teardownDrawingResize()
    this.toggleNoteVisibility(false)
    this.mobileComposeMode = false
    this.unlockBodyScroll()
    document.removeEventListener('mousedown', this.mouseDownEvent)
    this.reset()
  }

  openMobileComposer() {
    if (this.isEditing) return
    this.mobileComposeMode = true
    this.lockBodyScroll()
    this.notePhClick()
  }

  mobileBack() {
    const hasTitle = this.noteTitle?.nativeElement.innerHTML.trim().length > 0
    const hasBody = (this.noteBody?.nativeElement.innerHTML.trim().length ?? 0) > 0
    const hasCboxes = this.checkBoxes.length > 0
    const hasImages = this.images.length > 0
    const hasAttachments = this.attachments.length > 0 || this.pendingAttachmentFiles.length > 0

    if (hasTitle || hasBody || hasCboxes || hasImages || hasAttachments || this.isDrawingNote) {
      this.saveNote()
    } else {
      // Empty note — just close without saving
      if (this.isEditing) {
        this.Shared.closeModal.next(true)
      } else {
        this.closeNote()
      }
    }
  }

  toggleCbox() {
    const currentBodyHtml = this.noteBody?.nativeElement.innerHTML || ''
    if (this.isCbox.value) {
      if (this.checkBoxes.length) {
        this.isHybridNote = false
        this.isCbox.next(false)
        this.cd.detectChanges()
        this.restoreBodyHtmlAfterTemplateSwap(currentBodyHtml)
        this.noteBody?.nativeElement.focus()
        this.updateCheckboxMenuLabel()
        return
      }
      this.isCbox.next(false)
      return
    }

    if (this.hasMeaningfulBody(this.noteBody?.nativeElement.innerHTML)) {
      this.isHybridNote = true
    }
    this.isCbox.next(true)
    this.cd.detectChanges()
    this.restoreBodyHtmlAfterTemplateSwap(currentBodyHtml)
    this.cboxPh?.nativeElement.focus()
  }

  hasHybridBody(): boolean {
    return this.isHybridNote;
  }

  private hasMeaningfulBody(value?: string | null) {
    const div = document.createElement('div')
    div.innerHTML = value || ''
    return (div.textContent || div.innerText || '').replace(/\u00a0/g, ' ').trim().length > 0
      || !!div.querySelector('img, .editor-link-preview-slot')
  }

  private updateCheckboxMenuLabel() {
    if (this.isCbox.value) {
      this.moreMenuEls.checkbox.value = this.isHybridNote ? 'Checklists shown' : 'Add text'
    } else {
      this.moreMenuEls.checkbox.value = 'Show checkboxes'
    }
  }

  private restoreBodyHtmlAfterTemplateSwap(html: string) {
    if (!this.noteBody || !html) return
    const body = this.noteBody.nativeElement
    if (!body.innerHTML) {
      body.innerHTML = html
      this.hydrateEditorLinkPreviews()
      this.hydrateInlineImageButtons()
      this.updateInputLength({ body: body.innerHTML.length })
    }
  }

  //? note  -----------------------------------------------------

  async saveNote(closeAfterSave = true) {
    this.cboxInput?.nativeElement.blur()
    if (this.isDrawingNote) this.syncDrawingImage()
    if (this.isCbox.value && this.cboxPh?.nativeElement.innerHTML.trim()) {
      this.addCheckBoxFromPlaceholder()
    }
    const allCboxElements = this.noteContainer.nativeElement.querySelectorAll('[data-cbox-id]')
    allCboxElements.forEach((el: Element) => {
      const cboxEl = el as HTMLDivElement
      const idAttr = cboxEl.getAttribute('data-cbox-id')
      if (idAttr) {
        const id = Number(idAttr)
        const cb = this.checkBoxes.find(c => c.id === id)
        if (cb) {
          cb.data = cboxEl.innerHTML
        }
      }
    })
    const labelsForSave = await this.labelsForSave()
    let noteObj: NoteI = {
      noteTitle: this.noteTitle.nativeElement.innerHTML,
      noteBody: this.noteBody?.nativeElement.innerHTML ? this.cleanEditorBodyForSave(this.noteBody.nativeElement.innerHTML) : '',
      pinned: this.notePin.nativeElement.dataset['pinned'] === "true", // converting string to bool,
      bgColor: this.noteMain.nativeElement.style.backgroundColor,
      bgImage: this.noteMain.nativeElement.style.backgroundImage || this.noteContainer.nativeElement.style.backgroundImage,
      checkBoxes: this.checkBoxes,
      images: this.images.map(image => ({ ...image, dataUrl: this.auth.canonicalImageUrl(image.dataUrl) })),
      isCbox: this.isCbox.value,
      labels: labelsForSave,
      archived: this.isArchived,
      trashed: this.isTrashed
    }
    const hasContent = !!(noteObj.noteTitle.length || noteObj.noteBody && noteObj.noteBody?.length || this.checkBoxes.length || this.images.length || this.attachments.length || this.pendingAttachmentFiles.length || this.isDrawingNote)

    if (this.isEditing) {
      const noteChanged = this.noteChangedForSave(noteObj)
      const hasPendingReminderSave = !!(this.pendingReminderDate || this.pendingReminderLocation)
      if (!noteChanged && !hasPendingReminderSave) {
        if (closeAfterSave) this.Shared.closeModal.next(true)
        return
      }
      if (!closeAfterSave && this.coEditSaveInFlight) {
        this.coEditSaveQueued = true
        return
      }
      if (!closeAfterSave) {
        this.coEditSaveInFlight = true
        try {
          await this.notesService.update(noteObj, this.noteToEdit.id!)
          this.saveBaselineSnapshot = this.noteSaveSnapshot(noteObj)
          this.labelsDirty = false
          this.flushPendingReminderSaves(this.noteToEdit.id!, noteObj)
        } finally {
          this.coEditSaveInFlight = false
          if (this.coEditSaveQueued) {
            this.coEditSaveQueued = false
            this.saveNote(false)
          }
        }
      } else {
        await this.notesService.update(noteObj, this.noteToEdit.id!)
        this.saveBaselineSnapshot = this.noteSaveSnapshot(noteObj)
        this.labelsDirty = false
        this.updateLastEditedTime();
        this.flushPendingReminderSaves(this.noteToEdit.id!, noteObj)
      }
      if (closeAfterSave) this.Shared.closeModal.next(true)
      return
    }

    if (hasContent) {
        let id = await this.Shared.note.db.add(noteObj)
        if (!id || id <= 0) {
          if (closeAfterSave) this.showReminderSaveError()
          return
        }
        await this.uploadPendingAttachments(id)
        this.flushPendingReminderSaves(id, noteObj)
        if (this.isArchived) {
          this.Shared.snackBar({ action: 'archived', opposite: 'unarchived' }, { archived: false }, id)
        }
        if (this.isTrashed) {
          this.Shared.snackBar({ action: 'trashed', opposite: 'untrashed' }, { trashed: false }, id)
        }
        this.closeNote()
    }
  }

  private noteChangedForSave(noteObj: NoteI) {
    if (!this.isEditing || !this.noteToEdit?.id) return true
    if (this.pendingAttachmentFiles.length) return true
    const baseline = this.saveBaselineSnapshot ?? this.noteSaveSnapshot(this.noteToEdit)
    return this.noteSaveSnapshot(noteObj) !== baseline
  }

  private flushPendingReminderSaves(noteId: number, noteObj: NoteI) {
    if (!noteId || noteId <= 0) return
    const title = this.notePlainText(noteObj.noteTitle)
    const body = this.notePlainText(noteObj.noteBody)

    // Reminder saves are fire-and-forget and only run after the note itself
    // has been persisted, so native clients see a real noteId in the request.
    if (this.pendingReminderDate) {
      const reminderDate = this.pendingReminderDate
      this.pendingReminderDate = null
      this.reminderService.create({
        noteId,
        dueAtUtc: reminderDate.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        title,
        body
      }).then(result => {
        if (!result) this.showReminderSaveError()
      }).catch(() => this.showReminderSaveError())
    }

    if (this.pendingReminderLocation) {
      const location = this.pendingReminderLocation
      this.pendingReminderLocation = null
      this.reminderService.create({
        noteId,
        locationName: location.locationName,
        latitude: location.latitude,
        longitude: location.longitude,
        radiusMeters: location.radiusMeters,
        locationTrigger: location.locationTrigger,
        timezone: location.timezone,
        title,
        body
      }).then(result => {
        if (!result) this.showReminderSaveError()
      }).catch(() => this.showReminderSaveError())
    }
  }

  private noteSaveSnapshot(note: NoteI) {
    return JSON.stringify({
      noteTitle: note.noteTitle || '',
      noteBody: this.auth.canonicalImageHtml(note.noteBody || ''),
      pinned: !!note.pinned,
      bgColor: note.bgColor || '',
      bgImage: note.bgImage || '',
      checkBoxes: this.normalizeCheckBoxes(note.checkBoxes || []),
      images: this.normalizeImages(note.images || []),
      isCbox: !!note.isCbox,
      labels: this.normalizeLabels(note.labels || []),
      archived: !!note.archived,
      trashed: !!note.trashed
    })
  }

  private normalizeImages(images: any[] = []) {
    return images.map(image => ({
      id: image.id,
      dataUrl: this.auth.canonicalImageUrl(image.dataUrl || ''),
      name: image.name || '',
      placement: image.placement || 'bottom'
    }))
  }

  private normalizeLabels(labels: any[] = []) {
    return labels
      .filter(label => label.added !== false)
      .map(label => ({ id: label.id, name: label.name, added: label.added !== false }))
  }

  private async labelsForSave() {
    const selectedLabels = this.labels.filter(label => label.added)
    if (!this.isEditing || !this.noteToEdit?.id || this.labelsDirty) return selectedLabels

    try {
      const fresh = await this.notesService.get(this.noteToEdit.id, { merge: true })
      return this.normalizeLabels(fresh?.labels || [])
    } catch {
      return this.normalizeLabels(this.noteToEdit.labels || selectedLabels)
    }
  }

  private normalizeCheckBoxes(checkBoxes: CheckboxI[] = []) {
    return checkBoxes.map(item => ({
      id: item.id,
      done: !!item.done,
      data: item.data || ''
    }))
  }

  private notePlainText(value?: string | null) {
    const div = document.createElement('div')
    div.innerHTML = value || ''
    return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim()
  }

  reset() {
    this.noteTitle.nativeElement.innerHTML = ''
    if (this.noteBody) this.noteBody.nativeElement.innerHTML = ''
    this.notePin.nativeElement.dataset['pinned'] = 'false'
    this.noteContainer.nativeElement.style.backgroundImage = ''
    this.noteMain.nativeElement.style.backgroundImage = ''
    this.noteMain.nativeElement.style.backgroundColor = ''
    this.noteMain.nativeElement.style.borderColor = ''
    this.noteMain.nativeElement.style.color = ''
    this.hasBackgroundImage = false
    //
    this.checkBoxes = []
    this.images = []
    this.attachments = []
    this.pendingAttachmentFiles = []
    this.isUploadingAttachment = false
    this.isDrawingNote = false
    this.isDrawingFullscreen = false
    this.isHybridNote = false
    this.showTextFormatting = false
    this.showDrawingBackgroundMenu = false
    this.showDrawingMoreMenu = false
    this.showDrawingEraserMenu = false
    this.drawingOpenToolMenu = undefined
    this.clearDrawingSelection()
    this.drawingHistory = []
    this.drawingHistoryIndex = -1
    this.isCbox.next(false)
    this.isArchived = false
    this.isTrashed = false
    this.isCboxCompletedListCollapsed = false
    this.isPanning = false
    this.drawingTransform = { scale: 1, x: 0, y: 0 }
    this.activePointers.clear()
    this.inputLength.next({ title: 0, body: 0, cb: 0 })
  }


  async pasteEvent(event: ClipboardEvent) {
    const imageFiles = this.clipboardImageFiles(event)
    if (imageFiles.length) {
      event.preventDefault()
      if (this.noteMain.nativeElement.hidden) this.notePhClick()
      this.rememberBodySelection()
      await this.addImageFiles(imageFiles)
      return
    }

    // to remove text styling -> before : https://prnt.sc/a7M5g-kbofba, after : https://prnt.sc/D7KEV6rdlm_7
    event.preventDefault()
    let text = event.clipboardData?.getData('text/plain');
    let target = event.currentTarget as HTMLDivElement
    this.insertPlainTextAtCursor(target, text || '')
    if (this.noteBody?.nativeElement === target) {
      this.queueEditorLinkDecoration()
    } else if (this.noteTitle?.nativeElement === target) {
      this.onNoteTitleInput()
    }
    // document.execCommand('insertText', false, text)
    // ! TODO, when u paste, yji fel <br> => so ywali maybanch
  }

  private insertPlainTextAtCursor(target: HTMLElement, text: string) {
    target.focus()
    const selection = window.getSelection()
    let range: Range
    if (selection?.rangeCount && target.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      range = selection.getRangeAt(0)
      const common = range.commonAncestorContainer
      const commonEl = common.nodeType === Node.ELEMENT_NODE ? common as Element : common.parentElement
      const previewSlot = commonEl?.closest('.editor-link-preview-slot')
      if (previewSlot) {
        range = document.createRange()
        range.setStartAfter(previewSlot)
        range.collapse(true)
      } else {
        range.deleteContents()
      }
    } else {
      range = document.createRange()
      range.selectNodeContents(target)
      range.collapse(false)
    }

    const fragment = document.createDocumentFragment()
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    let lastNode: Node | null = null
    lines.forEach((line, index) => {
      if (index > 0) {
        lastNode = document.createElement('br')
        fragment.append(lastNode)
      }
      if (line) {
        lastNode = document.createTextNode(line)
        fragment.append(lastNode)
      }
    })
    range.insertNode(fragment)
    if (!lastNode) return
    range = document.createRange()
    range.setStartAfter(lastNode)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  private clipboardImageFiles(event: ClipboardEvent): File[] {
    const items = Array.from(event.clipboardData?.items || [])
    const files = items
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file)
    if (files.length) return files
    return Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'))
  }

  @HostListener('document:selectionchange')
  onDocumentSelectionChange() {
    this.rememberBodySelection()
  }

  rememberBodySelection() {
    const body = this.noteBody?.nativeElement
    const selection = window.getSelection()
    if (!body || !selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    if (body.contains(range.commonAncestorContainer)) {
      this.lastBodyRange = range.cloneRange()
    }
  }

  openImagePicker(event?: Event) {
    event?.preventDefault()
    event?.stopPropagation()
    if (this.noteMain.nativeElement.hidden) this.notePhClick()
    this.rememberBodySelection()
    this.imageInput.nativeElement.click()
  }

  async imageInputChange(event: Event) {
    const input = event.target as HTMLInputElement
    await this.addImageFiles(input.files)
    input.value = ''
  }

  async dropImages(event: DragEvent) {
    if (this.draggedInlineObject) {
      event.preventDefault()
      event.stopPropagation()
      this.moveInlineObjectToDrop(event)
      return
    }
    if (!event.dataTransfer?.files?.length) return
    event.preventDefault()
    event.stopPropagation()
    if (this.noteMain.nativeElement.hidden) this.notePhClick()
    await this.addImageFiles(event.dataTransfer.files, event)
  }

  dragOverImages(event: DragEvent) {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.draggedInlineObject ? 'move' : 'copy'
  }

  dragInlineImage(event: DragEvent) {
    const target = event.target as HTMLElement
    const inlineObject = target.closest('.inline-note-image-wrap, .editor-link-preview-slot') as HTMLElement | null
    if (!inlineObject) return
    this.draggedInlineImage = inlineObject.classList.contains('inline-note-image-wrap') ? inlineObject : undefined
    this.draggedInlineObject = inlineObject
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', inlineObject.classList.contains('editor-link-preview-slot') ? 'move-note-link-preview' : 'move-note-image')
    }
  }

  dragEndInlineImage() {
    this.draggedInlineImage = undefined
    this.draggedInlineObject = undefined
  }

  async addImageFiles(fileList: FileList | File[] | null, event?: DragEvent) {
    if (!fileList?.length) return
    const files = Array.from(fileList).filter(file => file.type.startsWith('image/'))
    if (!files.length) return
    if (this.isCbox.value) {
      this.isCbox.next(false)
      this.cd.detectChanges()
    }
    if (event) this.placeCaretFromDrop(event)
    const imageData = await Promise.all(files.map(file => this.fileToImage(file, 'bottom')))
    imageData.forEach(image => this.insertInlineImage(image))
    this.updateInputLength({ body: this.noteBody?.nativeElement.innerHTML.length || 0 })
    if (this.isEditing) await this.saveNote(false)
    this.queueCoEditAutosave()
  }

  fileToImage(file: File, placement: NoteImageI['placement']): Promise<NoteImageI> {
    return this.Shared.note.db.uploadImage(file).then(uploaded => ({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      dataUrl: this.auth.authenticatedImageUrl(uploaded.url),
      name: uploaded.name || file.name,
      placement
    }))
  }

  openAttachmentPicker(event?: Event) {
    event?.preventDefault()
    event?.stopPropagation()
    if (this.noteMain.nativeElement.hidden) this.notePhClick()
    this.attachmentInput.nativeElement.click()
  }

  async attachmentInputChange(event: Event) {
    const input = event.target as HTMLInputElement
    await this.addAttachmentFiles(input.files)
    input.value = ''
  }

  async addAttachmentFiles(fileList: FileList | null) {
    if (!fileList?.length) return
    const files = Array.from(fileList).filter(file => this.isAllowedAttachment(file))
    if (!files.length) {
      this.showAttachmentMessage('That file type is not supported.')
      return
    }
    const oversized = files.find(file => file.size > 25 * 1024 * 1024)
    if (oversized) {
      this.showAttachmentMessage('Attachments must be 25 MB or smaller.')
      return
    }

    if (!this.isEditing || !this.noteToEdit.id) {
      const existingKeys = new Set(this.pendingAttachmentFiles.map(file => `${file.name}:${file.size}:${file.lastModified}`))
      this.pendingAttachmentFiles = [
        ...this.pendingAttachmentFiles,
        ...files.filter(file => !existingKeys.has(`${file.name}:${file.size}:${file.lastModified}`))
      ]
      return
    }

    this.isUploadingAttachment = true
    try {
      for (const file of files) {
        const attachment = await this.Shared.note.db.uploadAttachment(this.noteToEdit.id, file)
        this.attachments = [attachment, ...this.attachments]
      }
      await this.notesService.load()
    } catch (error: any) {
      this.showAttachmentMessage(error?.error?.error || 'Could not attach that file.')
    } finally {
      this.isUploadingAttachment = false
    }
  }

  private async uploadPendingAttachments(noteId: number) {
    if (!this.pendingAttachmentFiles.length || !noteId || noteId === -1) return
    this.isUploadingAttachment = true
    try {
      for (const file of this.pendingAttachmentFiles) {
        await this.Shared.note.db.uploadAttachment(noteId, file)
      }
      this.pendingAttachmentFiles = []
      await this.notesService.load()
    } catch (error: any) {
      this.showAttachmentMessage(error?.error?.error || 'The note was saved, but an attachment could not be uploaded.')
    } finally {
      this.isUploadingAttachment = false
    }
  }

  removePendingAttachment(file: File, event?: Event) {
    event?.preventDefault()
    event?.stopPropagation()
    this.pendingAttachmentFiles = this.pendingAttachmentFiles.filter(item => item !== file)
  }

  async deleteAttachment(attachment: NoteAttachmentI, event?: Event) {
    event?.preventDefault()
    event?.stopPropagation()
    if (!this.noteToEdit.id) return
    try {
      await this.Shared.note.db.deleteAttachment(this.noteToEdit.id, attachment.id)
      this.attachments = this.attachments.filter(item => item.id !== attachment.id)
      await this.notesService.load()
    } catch (error: any) {
      this.showAttachmentMessage(error?.error?.error || 'Could not delete attachment.')
    }
  }

  async downloadAttachment(attachment: NoteAttachmentI, event?: Event) {
    event?.preventDefault()
    event?.stopPropagation()
    try {
      await this.notesService.downloadAttachment(attachment)
    } catch (error: any) {
      this.showAttachmentMessage(error?.error?.error || 'Could not download attachment.')
    }
  }

  attachmentIcon(attachment: Pick<NoteAttachmentI, 'mimeType' | 'originalName'> | File) {
    const name = 'name' in attachment ? attachment.name : attachment.originalName
    const mime = 'type' in attachment ? attachment.type : attachment.mimeType
    const ext = name.split('.').pop()?.toLowerCase() || ''
    if (mime.startsWith('image/')) return 'image'
    if (mime.includes('pdf')) return 'picture_as_pdf'
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

  private isAllowedAttachment(file: File) {
    const ext = `.${file.name.split('.').pop()?.toLowerCase() || ''}`
    return this.attachmentAccept.split(',').includes(ext)
  }

  private showAttachmentMessage(message: string) {
    try {
      Snackbar.show({ pos: 'bottom-left', text: message, duration: 3600 })
    } catch {}
  }

  moveImage(image: NoteImageI) {
    image.placement = image.placement === 'top' ? 'bottom' : 'top'
    this.queueCoEditAutosave()
  }

  removeImage(imageId: string) {
    this.images = this.images.filter(image => image.id !== imageId)
    this.inputLength.next({ ...this.inputLength.value, body: (this.noteBody?.nativeElement.innerHTML.length || 0) + this.images.length })
    this.queueCoEditAutosave()
  }

  private insertInlineImage(image: NoteImageI) {
    const body = this.noteBody?.nativeElement
    if (!body) return
    body.focus()

    const wrapper = this.buildInlineImageWrapper(image.dataUrl, image.name)

    const range = this.currentBodyRange(body)
    range.deleteContents()
    range.insertNode(wrapper)
    const spacer = document.createElement('div')
    spacer.innerHTML = '<br>'
    wrapper.after(spacer)
    range.setStartAfter(spacer)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    this.lastBodyRange = range.cloneRange()
    this.onNoteBodyInput(body)
  }

  private buildInlineImageWrapper(src: string, alt: string) {
    const wrapper = document.createElement('div')
    wrapper.className = 'inline-note-image-wrap'
    wrapper.contentEditable = 'false'

    const img = document.createElement('img')
    img.className = 'inline-note-image'
    img.src = this.auth.authenticatedImageUrl(src)
    img.alt = alt || ''
    wrapper.appendChild(img)

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'inline-image-delete-btn H'
    del.setAttribute('aria-label', 'Delete image')
    del.dataset['inlineImageTool'] = 'delete'
    del.innerHTML = '<span class="material-symbols-outlined">close</span>'
    wrapper.appendChild(del)

    return wrapper
  }

  // Adds delete buttons to inline images that came in via saved noteBody HTML
  // (which doesn't include the button markup since it's stripped on save).
  private hydrateInlineImageButtons() {
    const body = this.noteBody?.nativeElement
    if (!body) return
    body.querySelectorAll<HTMLElement>('.inline-note-image-wrap').forEach(wrap => {
      if (wrap.querySelector('.inline-image-delete-btn')) return
      wrap.contentEditable = 'false'
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'inline-image-delete-btn H'
      del.setAttribute('aria-label', 'Delete image')
      del.dataset['inlineImageTool'] = 'delete'
      del.innerHTML = '<span class="material-symbols-outlined">close</span>'
      wrap.appendChild(del)
    })
  }

  onNoteBodyClick(event: Event) {
    const target = event.target as HTMLElement
    const deleteBtn = target.closest('[data-inline-image-tool="delete"]') as HTMLElement | null
    if (!deleteBtn) return
    event.preventDefault()
    event.stopPropagation()
    const wrap = deleteBtn.closest('.inline-note-image-wrap') as HTMLElement | null
    if (!wrap) return
    // Also remove the trailing <br> spacer that was inserted alongside the wrapper.
    const next = wrap.nextElementSibling
    wrap.remove()
    if (next && next.tagName === 'DIV' && next.innerHTML.trim().toLowerCase() === '<br>') next.remove()
    const body = this.noteBody?.nativeElement
    if (body) this.onNoteBodyInput(body)
    this.queueCoEditAutosave()
  }

  private moveInlineObjectToDrop(event: DragEvent) {
    const body = this.noteBody?.nativeElement
    const inlineObject = this.draggedInlineObject
    if (!body || !inlineObject) return

    this.placeCaretFromDrop(event)
    const range = this.currentBodyRange(body)
    if (inlineObject.contains(range.commonAncestorContainer)) {
      this.dragEndInlineImage()
      return
    }

    range.deleteContents()
    range.insertNode(inlineObject)
    const spacer = document.createElement('div')
    spacer.innerHTML = '<br>'
    inlineObject.after(spacer)
    range.setStartAfter(spacer)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    this.onNoteBodyInput(body)
    this.dragEndInlineImage()
  }

  private currentBodyRange(body: HTMLDivElement) {
    const selection = window.getSelection()
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0)
      if (body.contains(range.commonAncestorContainer)) return range
    }
    if (this.lastBodyRange && body.contains(this.lastBodyRange.commonAncestorContainer)) {
      return this.lastBodyRange.cloneRange()
    }
    const range = document.createRange()
    range.selectNodeContents(body)
    range.collapse(false)
    return range
  }

  private placeCaretFromDrop(event: DragEvent) {
    const body = this.noteBody?.nativeElement
    if (!body) return
    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node, offset: number } | null
    }
    const range = documentWithCaret.caretRangeFromPoint?.(event.clientX, event.clientY)
    const position = documentWithCaret.caretPositionFromPoint?.(event.clientX, event.clientY)
      const nextRange = range || document.createRange()
    if (!range && position) nextRange.setStart(position.offsetNode, position.offset)
    const inlineObject = this.draggedInlineObject
    if (inlineObject && inlineObject.contains(nextRange.commonAncestorContainer)) return
    if (body.contains(nextRange.commonAncestorContainer)) {
      nextRange.collapse(true)
      this.lastBodyRange = nextRange.cloneRange()
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(nextRange)
    }
  }


  //? checkboxes  --------------------------------------------------

  cboxPhKeyDown($event: KeyboardEvent) {
    $event.preventDefault()
    const isLetter = /^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"²^\\|,.<>\/?éèçµ]$/i.test($event.key)
    // ex : if he clicked the f1 btn for example, nothing would happen, otherwise : 
    if (!isLetter) return
    let enteredValue = $event.key
    this.addCheckBox(enteredValue) // a new checkbox will appear in the html
    this.cd.detectChanges()
    let el = document.querySelector(`[data-cbox-last="true"]`)
    // we move the cursor to the end, so the user will just continue what he typed before
    let sel = window.getSelection()
    if (el) sel?.selectAllChildren(el)
    sel?.collapseToEnd()
  }

  cboxPhClick() {
    this.addCheckBox('')
    this.cd.detectChanges()
    const el = document.querySelector(`[data-cbox-last="true"]`) as HTMLDivElement
    if (el) el.focus()
  }

  addCheckBox(data: string, insertAfterId?: number) {
    const maxId = this.checkBoxes.reduce((m, c) => Math.max(m, c.id ?? 0), -1)
    const cb = {
      done: false,
      data: data,
      id: maxId + 1
    }
    if (insertAfterId !== undefined) {
      const idx = this.checkBoxes.findIndex(item => item.id === insertAfterId)
      if (idx >= 0) {
        this.checkBoxes.splice(idx + 1, 0, cb)
      } else {
        this.checkBoxes.push(cb)
      }
    } else {
      this.checkBoxes.push(cb)
    }
    this.inputLength.next({ ...this.inputLength.value, cb: this.checkBoxes.length })
    this.queueCoEditAutosave()
    return cb
  }

  addCheckBoxFromPlaceholder() {
    const value = this.cboxPh?.nativeElement.innerHTML || ''
    this.cboxPh?.nativeElement.replaceChildren()
    if (value.trim()) this.addCheckBox(value)
  }

  cboxInputFocus(event: FocusEvent) {
    const el = event.target as HTMLDivElement
    setTimeout(() => {
      const range = document.createRange()
      const sel = window.getSelection()
      range.selectNodeContents(el)
      range.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(range)
    }, 0)
  }

  cBoxKeyDown($event: KeyboardEvent, id: number) {
    let target = $event.target as HTMLDivElement
    if ($event.key === 'Enter') {
      $event.preventDefault()
      // Insert the new row immediately after the row Enter was hit in,
      // not at the end of the list — matches Google Keep's behavior.
      const newCb = this.addCheckBox('', id)
      this.cd.detectChanges()
      const newEl = document.querySelector(`[data-cbox-id="${newCb.id}"]`) as HTMLDivElement
      newEl?.focus()
    }
    if ($event.key === 'Backspace') {
      const sel = window.getSelection()
      const isAtStart = sel?.anchorOffset === 0 && sel?.focusOffset === 0
      if (isAtStart) {
        $event.preventDefault()
        const idx = this.checkBoxes.findIndex(cb => cb.id === id)
        if (idx > 0) {
          const prevCb = this.checkBoxes[idx - 1]
          const prevEl = document.querySelector(`[data-cbox-id="${prevCb.id}"]`) as HTMLDivElement
          this.cboxTools(id).remove()
          this.cd.detectChanges()
          prevEl?.focus()
          const range = document.createRange()
          const sel = window.getSelection()
          range.selectNodeContents(prevEl)
          range.collapse(false)
          sel?.removeAllRanges()
          sel?.addRange(range)
        } else {
          this.cboxTools(id).remove()
        }
      }
    }
  }


  cboxPrepareDrag(id: number) {
    this.dragReadyCboxId = id
  }

  cboxCancelDrag() {
    this.dragReadyCboxId = undefined
  }

  cboxDragStart(id: number, event: DragEvent) {
    this.draggedCboxId = id
    this.cboxDragOrderChanged = false
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      const row = event.currentTarget as HTMLElement
      this.createCboxDragImage(row, event.clientX, event.clientY)
      this.moveCboxDragImage(event)
      event.dataTransfer.setDragImage(this.getTransparentDragImage(), 0, 0)
    }
  }

  onNoteBodyInput(body: HTMLDivElement) {
    const saveHtml = this.cleanEditorBodyForSave(body.innerHTML)
    this.updateInputLength({ body: saveHtml.length })
    this.queueCoEditAutosave()
  }

  onNoteTitleInput() {
    this.updateInputLength({ title: this.noteTitle.nativeElement.innerHTML.length })
    this.queueCoEditAutosave()
  }

  private queueCoEditAutosave() {
    if (!this.isEditing || !this.noteToEdit.id || this.activeEditors.length === 0) return
    this.autoSaveSubject.next()
  }

  private extractUrlsFromHtml(html: string) {
    const urls = new Set<string>()
    const div = document.createElement('div')
    div.innerHTML = html || ''

    div.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
      const href = anchor.href || anchor.getAttribute('href') || ''
      if (/^https?:\/\//i.test(href)) urls.add(href)
    })

    const text = div.textContent || ''
    const matches = text.match(/https?:\/\/[^\s"'<>]+/g) || []
    matches.forEach(url => urls.add(url.replace(/[),.;:!?]+$/, '')))

    return [...urls].slice(0, 3)
  }

  private decorateLinksForEditor(html: string) {
    const div = document.createElement('div')
    div.innerHTML = this.auth.authenticatedImageHtml(html || '')
    this.removePreviewMarkup(div)

    div.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
      const href = anchor.href || anchor.getAttribute('href') || ''
      if (!/^https?:\/\//i.test(href)) return
      const marker = document.createElement('span')
      marker.className = 'editor-link-preview-slot'
      marker.contentEditable = 'false'
      marker.dataset['url'] = href
      marker.dataset['originalHtml'] = anchor.outerHTML
      anchor.replaceWith(marker)
    })

    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const parent = node.parentElement
        if (!parent || parent.closest('.editor-hidden-link')) return NodeFilter.FILTER_REJECT
        return /https?:\/\/[^\s"'<>]+/.test(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      }
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
        const visibleUrl = rawUrl.replace(/[),.;:!?]+$/, '')
        const trailing = rawUrl.slice(visibleUrl.length)
        if (start > lastIndex) fragment.append(document.createTextNode(text.slice(lastIndex, start)))
        const marker = document.createElement('span')
        marker.className = 'editor-link-preview-slot'
        marker.contentEditable = 'false'
        marker.dataset['url'] = visibleUrl
        marker.dataset['originalHtml'] = visibleUrl
        fragment.append(marker)
        if (trailing) fragment.append(document.createTextNode(trailing))
        lastIndex = start + rawUrl.length
      }
      if (lastIndex < text.length) fragment.append(document.createTextNode(text.slice(lastIndex)))
      node.replaceWith(fragment)
    })

    return div.innerHTML
  }

  private cleanEditorBodyForSave(html: string) {
    const div = document.createElement('div')
    div.innerHTML = this.auth.canonicalImageHtml(html || '')
    this.removePreviewMarkup(div)
    // Strip editor-only chrome (e.g. the inline image delete button) that lives
    // inside the editable body but has no business being persisted.
    div.querySelectorAll('[data-inline-image-tool]').forEach(el => el.remove())
    div.querySelectorAll<HTMLElement>('.editor-link-preview-slot').forEach(marker => {
      const template = document.createElement('template')
      template.innerHTML = marker.dataset['originalHtml'] || marker.dataset['url'] || ''
      marker.replaceWith(template.content)
    })
    return div.innerHTML
  }

  private removePreviewMarkup(root: HTMLElement) {
    root.querySelectorAll<HTMLElement>('.editor-link-preview-slot').forEach(marker => {
      marker.querySelectorAll('.editor-link-preview-card').forEach(el => el.remove())
    })
    root.querySelectorAll<HTMLElement>('app-link-preview, .editor-link-previews, .lp-card, .editor-link-preview-card').forEach(el => el.remove())
  }

  private decorateCurrentBodyLinks() {
    const body = this.noteBody?.nativeElement
    if (!body || this.destroyed) return
    this.editorPreviewGeneration++
    body.innerHTML = this.decorateLinksForEditor(this.cleanEditorBodyForSave(body.innerHTML))
    this.hydrateEditorLinkPreviews()
  }

  private queueEditorLinkDecoration() {
    if (this.editorLinkDecorationFrame) cancelAnimationFrame(this.editorLinkDecorationFrame)
    this.editorLinkDecorationFrame = requestAnimationFrame(() => {
      this.editorLinkDecorationFrame = undefined
      if (this.destroyed) return
      const body = this.noteBody?.nativeElement
      if (!body) return
      this.decorateCurrentBodyLinks()
      this.onNoteBodyInput(body)
    })
  }

  private hydrateEditorLinkPreviews() {
    const body = this.noteBody?.nativeElement
    if (!body || this.destroyed) return
    const generation = this.editorPreviewGeneration
    body.querySelectorAll<HTMLElement>('.editor-link-preview-slot:not([data-hydrated])').forEach(slot => {
      const url = slot.dataset['url']
      if (!url) return
      slot.dataset['hydrated'] = 'true'
      slot.replaceChildren(this.editorPreviewShell(url))
      this.notesService.getLinkPreview(url)
        .then(preview => {
          if (!this.isLiveEditorPreviewSlot(slot, generation)) return
          slot.replaceChildren(this.editorPreviewCard(url, preview))
        })
        .catch(() => {
          if (!this.isLiveEditorPreviewSlot(slot, generation)) return
          slot.replaceChildren(this.editorPreviewCard(url))
        })
    })
  }

  private isLiveEditorPreviewSlot(slot: HTMLElement, generation: number) {
    const body = this.noteBody?.nativeElement
    return !this.destroyed
      && generation === this.editorPreviewGeneration
      && !!body
      && slot.isConnected
      && body.contains(slot)
  }

  private editorPreviewShell(url: string) {
    const card = document.createElement('span')
    card.className = 'editor-link-preview-card loading'
    card.contentEditable = 'false'
    card.textContent = this.linkDomain(url)
    card.prepend(this.editorPreviewRemoveButton())
    return card
  }

  private editorPreviewCard(url: string, preview?: LinkPreviewData) {
    const card = document.createElement('span')
    card.className = 'editor-link-preview-card'
    card.contentEditable = 'false'
    card.draggable = true
    card.title = preview?.url || url
    card.addEventListener('click', event => {
      event.stopPropagation()
      window.open(preview?.url || url, '_blank', 'noopener,noreferrer')
    })
    card.append(this.editorPreviewRemoveButton())

    if (preview?.image) {
      const img = document.createElement('img')
      img.className = 'editor-link-preview-thumb'
      img.src = preview.image
      img.alt = preview.title || ''
      img.addEventListener('error', () => img.remove())
      card.append(img)
    }

    const text = document.createElement('span')
    text.className = 'editor-link-preview-text'
    const title = document.createElement('span')
    title.className = 'editor-link-preview-title'
    title.textContent = preview?.title || this.linkDomain(url) || url
    const domain = document.createElement('span')
    domain.className = 'editor-link-preview-domain'
    domain.textContent = preview?.domain || this.linkDomain(url)
    text.append(title, domain)
    card.append(text)

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'editor-link-preview-action'
    copy.title = 'Copy link'
    copy.innerHTML = '<span class="material-symbols-outlined">link</span>'
    copy.addEventListener('click', event => {
      event.stopPropagation()
      this.copyLink(url)
      copy.title = 'Copied'
      setTimeout(() => copy.title = 'Copy link', 1200)
    })

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'editor-link-preview-action'
    open.title = 'Open link'
    open.innerHTML = '<span class="material-symbols-outlined">open_in_new</span>'
    open.addEventListener('click', event => {
      event.stopPropagation()
      window.open(preview?.url || url, '_blank', 'noopener,noreferrer')
    })
    card.append(copy, open)
    return card
  }

  private editorPreviewRemoveButton() {
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'editor-link-preview-remove'
    remove.title = 'Remove link preview'
    remove.setAttribute('aria-label', 'Remove link preview')
    remove.innerHTML = '<span class="material-symbols-outlined">close</span>'
    remove.addEventListener('mousedown', event => event.stopPropagation())
    remove.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      const slot = remove.closest('.editor-link-preview-slot')
      slot?.remove()
      if (this.noteBody?.nativeElement) this.onNoteBodyInput(this.noteBody.nativeElement)
    })
    return remove
  }

  private async copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = url
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
  }

  private linkDomain(url: string) {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }

  toggleTextFormatting(event: Event) {
    event.stopPropagation()
    this.showTextFormatting = !this.showTextFormatting
  }

  applyTextFormat(command: 'h1' | 'h2' | 'body' | 'bold' | 'italic' | 'underline' | 'clear', event: Event) {
    event.preventDefault()
    event.stopPropagation()
    if (command === 'h1') document.execCommand('formatBlock', false, 'H1')
    if (command === 'h2') document.execCommand('formatBlock', false, 'H2')
    if (command === 'body') document.execCommand('formatBlock', false, 'DIV')
    if (command === 'bold') document.execCommand('bold')
    if (command === 'italic') document.execCommand('italic')
    if (command === 'underline') document.execCommand('underline')
    if (command === 'clear') document.execCommand('removeFormat')
    this.updateInputLength({
      title: this.noteTitle?.nativeElement.innerHTML.length || 0,
      body: this.noteBody?.nativeElement.innerHTML.length || 0
    })
    this.queueCoEditAutosave()
  }

  togglePinned() {
    const pinned = this.notePin.nativeElement.dataset['pinned'] === 'true'
    this.notePin.nativeElement.dataset['pinned'] = pinned ? 'false' : 'true'
    this.queueCoEditAutosave()
  }

  openDrawingNote(event?: Event) {
    event?.stopPropagation()
    this.toggleNoteVisibility(true)
    this.isDrawingNote = true
    this.isCbox.next(false)
    this.setupDrawingCanvas()
    if (!this.isEditing) document.addEventListener('mousedown', this.mouseDownEvent)
  }

  private setupDrawingCanvas(loadImage = true) {
    setTimeout(() => {
      const canvas = this.drawingCanvas?.nativeElement
      const wrap = this.drawingWrap?.nativeElement
      if (!canvas || !wrap) return
      const existingDrawing = this.images.find(image => image.id === 'drawing')
      this.drawingBackground = this.drawingBackgroundFromImage(existingDrawing)
      const rect = wrap.getBoundingClientRect()
      if (loadImage && existingDrawing?.dataUrl) {
        const image = new Image()
        image.onload = () => {
          const size = this.drawingCanvasSize(rect, image.naturalWidth, image.naturalHeight)
          canvas.width = size.width
          canvas.height = size.height
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.imageSmoothingEnabled = false
          this.drawStoredDrawingImage(ctx, image)
          this.pushDrawingHistory()
        }
        image.src = existingDrawing.dataUrl
      } else {
        const size = this.drawingCanvasSize(rect)
        canvas.width = size.width
        canvas.height = size.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        this.pushDrawingHistory()
      }
      this.teardownDrawingResize()
      this.drawingResize = new ResizeObserver(() => this.resizeDrawingCanvas())
      this.drawingResize.observe(wrap)
    })
  }

  private resizeDrawingCanvas() {
    const canvas = this.drawingCanvas?.nativeElement
    const wrap = this.drawingWrap?.nativeElement
    if (!canvas || !wrap) return
    const dataUrl = canvas.toDataURL('image/png')
    const rect = wrap.getBoundingClientRect()
    const width = Math.max(canvas.width, Math.floor(rect.width), 640)
    const height = Math.max(canvas.height, Math.floor(rect.height), this.isDrawingFullscreen ? 520 : 360)
    if (canvas.width === width && canvas.height === height) return
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const image = new Image()
    image.onload = () => {
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(image, 0, 0)
      this.updateDrawingSelectionStyle()
    }
    image.src = dataUrl
  }

  private drawingCanvasSize(rect: DOMRect, imageWidth = 0, imageHeight = 0) {
    return {
      width: Math.max(640, Math.floor(rect.width), imageWidth),
      height: Math.max(this.isDrawingFullscreen ? 520 : 360, Math.floor(rect.height), imageHeight)
    }
  }

  private teardownDrawingResize() {
    this.drawingResize?.disconnect()
    this.drawingResize = undefined
  }

  drawingPointerDown(event: PointerEvent) {
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (this.activePointers.size > 1) {
      if (this.isDrawing) {
        this.isDrawing = false
        this.restoreDrawingHistory()
      }
      this.isPanning = true
      this.setupPinchState()
      return
    }

    if (this.isPanning) return

    // If a resize handle already captured this pointer, don't steal it.
    if (this.movingSelection?.handle) return
    this.drawingOpenToolMenu = undefined;
    this.showDrawingBackgroundMenu = false;
    this.showDrawingEraserMenu = false;
    this.showDrawingMoreMenu = false;
    const canvas = this.drawingCanvas?.nativeElement
    if (!canvas) return
    event.preventDefault()
    try { canvas.setPointerCapture(event.pointerId) } catch {}
    const point = this.drawingPoint(event)
    if (this.drawingTool === 'select') {
      this.startDrawingSelection(point)
      return
    }
    this.isDrawing = true
    this.drawingLastPoint = point
  }

  private setupPinchState() {
    const pointers = Array.from(this.activePointers.values())
    this.initialPinchDistance = this.getDistance(pointers[0], pointers[1])
    this.initialPinchScale = this.drawingTransform.scale
    this.initialPinchMidpoint = this.getMidpoint(pointers[0], pointers[1])
    this.initialPinchTranslate = { x: this.drawingTransform.x, y: this.drawingTransform.y }
  }

  private handlePinchMove() {
    const pointers = Array.from(this.activePointers.values())
    const currentDistance = this.getDistance(pointers[0], pointers[1])
    const currentMidpoint = this.getMidpoint(pointers[0], pointers[1])

    if (this.initialPinchDistance && this.initialPinchScale !== undefined && this.initialPinchMidpoint) {
      const deltaScale = currentDistance / this.initialPinchDistance
      let newScale = this.initialPinchScale * deltaScale
      newScale = Math.max(0.5, Math.min(newScale, 5))

      // Calculate how much we actually scaled relative to the initial pinch start
      const actualDeltaScale = newScale / this.initialPinchScale

      // Zoom toward the midpoint:
      // The new position is the current finger midpoint minus the scaled distance from the initial midpoint to the original top-left
      const newX = currentMidpoint.x - (this.initialPinchMidpoint.x - this.initialPinchTranslate!.x) * actualDeltaScale
      const newY = currentMidpoint.y - (this.initialPinchMidpoint.y - this.initialPinchTranslate!.y) * actualDeltaScale

      this.drawingTransform = {
        scale: newScale,
        x: newX,
        y: newY
      }
    }
  }

  private getDistance(p1: { x: number, y: number }, p2: { x: number, y: number }) {
    return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2))
  }

  private getMidpoint(p1: { x: number, y: number }, p2: { x: number, y: number }) {
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  }

  drawingPointerMove(event: PointerEvent) {
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (this.activePointers.size === 2) {
      this.handlePinchMove()
      return
    }

    if (this.isPanning) return

    if (this.drawingTool === 'select') {
      this.updateDrawingSelection(this.drawingPoint(event))
      return
    }
    if (!this.isDrawing || !this.drawingLastPoint) return
    const point = this.drawingPoint(event)
    const ctx = this.drawingCanvas?.nativeElement.getContext('2d')
    if (!ctx) return
    const tool = this.drawingTool
    const options = tool === 'marker' ? this.drawingToolOptions.marker : tool === 'highlighter' ? this.drawingToolOptions.highlighter : this.drawingToolOptions.pen
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    ctx.globalAlpha = tool === 'highlighter' ? 0.35 : 1
    ctx.strokeStyle = options.color
    ctx.lineWidth = tool === 'eraser' ? 24 : options.size
    ctx.beginPath()
    ctx.moveTo(this.drawingLastPoint.x, this.drawingLastPoint.y)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
    ctx.restore()
    this.drawingLastPoint = point
  }

  drawingPointerUp(event: PointerEvent) {
    this.activePointers.delete(event.pointerId)
    if (this.activePointers.size === 0) {
      this.isPanning = false
    }

    if (this.drawingTool === 'select') {
      this.finishDrawingSelection()
      if (event.target && (event.target as HTMLElement).releasePointerCapture) { (event.target as HTMLElement).releasePointerCapture(event.pointerId) } else { this.drawingCanvas?.nativeElement.releasePointerCapture(event.pointerId) }
      return
    }
    if (!this.isDrawing) return
    this.isDrawing = false
    this.drawingLastPoint = undefined
    this.drawingCanvas?.nativeElement.releasePointerCapture(event.pointerId)
    this.pushDrawingHistory()
    this.syncDrawingImage()
    this.queueCoEditAutosave()
  }

  startDrawingResize(handle: string, event: PointerEvent) {
    try {
      event.stopPropagation();
      event.preventDefault();
      const ctx = this.drawingCanvas?.nativeElement.getContext('2d');
      if (!ctx || !this.drawingSelection) return;
      const rect = this.normalizeSelection(this.drawingSelection);
      if (rect.w < 1 || rect.h < 1) return;

      const image = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
      
      const offscreen = document.createElement('canvas');
      offscreen.width = rect.w;
      offscreen.height = rect.h;
      offscreen.getContext('2d')?.putImageData(image, 0, 0);

      const point = this.drawingPoint(event);
      this.movingSelection = {
        canvas: offscreen,
        offset: { x: point.x - rect.x, y: point.y - rect.y },
        lastRect: rect,
        handle,
        aspectRatio: rect.w / rect.h,
        fixedPoint: {
          x: handle.includes('e') ? rect.x : rect.x + rect.w,
          y: handle.includes('s') ? rect.y : rect.y + rect.h
        }
      };
      this.isDrawing = true;
      if (event.target && (event.target as HTMLElement).setPointerCapture) {
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
      }
    } catch (e) {
      console.error(e);
    }
  }

  private startDrawingSelection(point: DrawingPoint) {
    try {
      const existing = this.drawingSelection
      if (existing && this.pointInSelection(point, existing)) {
        const ctx = this.drawingCanvas?.nativeElement.getContext('2d')
        if (!ctx) return
        const rect = this.normalizeSelection(existing)
        if (rect.w < 1 || rect.h < 1) return;
        const image = ctx.getImageData(rect.x, rect.y, rect.w, rect.h)
        ctx.clearRect(rect.x, rect.y, rect.w, rect.h)
        
        const offscreen = document.createElement('canvas');
        offscreen.width = rect.w;
        offscreen.height = rect.h;
        offscreen.getContext('2d')?.putImageData(image, 0, 0);

        this.movingSelection = {
          canvas: offscreen,
          offset: { x: point.x - rect.x, y: point.y - rect.y },
          lastRect: rect
        }
        this.isDrawing = true
        return
      }
      this.clearDrawingSelection()
      this.drawingSelectionStart = point
      this.drawingSelection = { x: point.x, y: point.y, w: 0, h: 0 }
      this.updateDrawingSelectionStyle()
      this.isDrawing = true
    } catch (e) {
      console.error(e);
    }
  }

  private updateDrawingSelection(point: DrawingPoint) {
    try {
      if (!this.isDrawing) return
      if (this.movingSelection) {
        const ctx = this.drawingCanvas?.nativeElement.getContext('2d')
        if (!ctx) return
        
        let next = { ...this.movingSelection.lastRect };

        if (this.movingSelection.handle) {
          const handle = this.movingSelection.handle;
          const ar = this.movingSelection.aspectRatio || 1;
          const fixedX = this.movingSelection.fixedPoint!.x;
          const fixedY = this.movingSelection.fixedPoint!.y;

          let rawW = Math.abs(point.x - fixedX);
          let rawH = Math.abs(point.y - fixedY);

          let newW, newH;
          if (rawW / ar > rawH) {
            newW = rawW; newH = rawW / ar;
          } else {
            newH = rawH; newW = rawH * ar;
          }

          if (newW < 4 || newH < 4) { newW = 4; newH = 4 / ar; }

          next.w = newW; next.h = newH;
          next.x = handle.includes('e') ? fixedX : fixedX - newW;
          next.y = handle.includes('s') ? fixedY : fixedY - newH;
        } else {
          next.x = Math.round(point.x - this.movingSelection.offset.x);
          next.y = Math.round(point.y - this.movingSelection.offset.y);
        }

        ctx.clearRect(this.movingSelection.lastRect.x - 2, this.movingSelection.lastRect.y - 2, this.movingSelection.lastRect.w + 4, this.movingSelection.lastRect.h + 4)
        if (next.w > 0 && next.h > 0) {
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(this.movingSelection.canvas, next.x, next.y, next.w, next.h)
        }
        this.movingSelection.lastRect = next
        this.drawingSelection = next
        this.updateDrawingSelectionStyle()
        return
      }
      if (!this.drawingSelectionStart) return
      this.drawingSelection = {
        x: this.drawingSelectionStart.x,
        y: this.drawingSelectionStart.y,
        w: point.x - this.drawingSelectionStart.x,
        h: point.y - this.drawingSelectionStart.y
      }
      this.updateDrawingSelectionStyle()
    } catch (e) {
      console.error(e);
    }
  }

  private finishDrawingSelection() {
    if (!this.isDrawing) return
    this.isDrawing = false
    this.drawingSelectionStart = undefined
    if (this.movingSelection) {
      this.movingSelection = undefined
      this.pushDrawingHistory()
      this.syncDrawingImage()
      this.queueCoEditAutosave()
      return
    }
    if (!this.drawingSelection || Math.abs(this.drawingSelection.w) < 4 || Math.abs(this.drawingSelection.h) < 4) {
      this.clearDrawingSelection()
      return
    }
    this.drawingSelection = this.normalizeSelection(this.drawingSelection)
    this.updateDrawingSelectionStyle()
  }

  private normalizeSelection(selection: DrawingSelection): DrawingSelection {
    return {
      x: Math.round(selection.w < 0 ? selection.x + selection.w : selection.x),
      y: Math.round(selection.h < 0 ? selection.y + selection.h : selection.y),
      w: Math.round(Math.abs(selection.w)),
      h: Math.round(Math.abs(selection.h))
    }
  }

  private pointInSelection(point: DrawingPoint, selection: DrawingSelection) {
    const rect = this.normalizeSelection(selection)
    return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
  }

  private updateDrawingSelectionStyle() {
    const canvas = this.drawingCanvas?.nativeElement
    if (!canvas || !this.drawingSelection) {
      this.drawingSelectionStyle = {}
      return
    }
    const rect = this.normalizeSelection(this.drawingSelection)
    this.drawingSelectionStyle = {
      left: `${rect.x / canvas.width * 100}%`,
      top: `${rect.y / canvas.height * 100}%`,
      width: `${rect.w / canvas.width * 100}%`,
      height: `${rect.h / canvas.height * 100}%`
    }
  }

  clearDrawingSelection() {
    this.drawingSelection = undefined
    this.drawingSelectionStyle = {}
    this.drawingSelectionStart = undefined
    this.movingSelection = undefined
  }

  private drawingPoint(event: PointerEvent) {
    const canvas = this.drawingCanvas!.nativeElement
    const rect = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height)
    }
  }

  private pushDrawingHistory() {
    const canvas = this.drawingCanvas?.nativeElement
    if (!canvas) return
    this.drawingHistory = this.drawingHistory.slice(0, this.drawingHistoryIndex + 1)
    this.drawingHistory.push(canvas.toDataURL('image/png'))
    this.drawingHistoryIndex = this.drawingHistory.length - 1
  }

  undoDrawing() {
    if (this.drawingHistoryIndex <= 0) return
    this.drawingHistoryIndex--
    this.restoreDrawingHistory()
    this.syncDrawingImage()
    this.queueCoEditAutosave()
  }

  redoDrawing() {
    if (this.drawingHistoryIndex >= this.drawingHistory.length - 1) return
    this.drawingHistoryIndex++
    this.restoreDrawingHistory()
    this.syncDrawingImage()
    this.queueCoEditAutosave()
  }

  private restoreDrawingHistory() {
    const canvas = this.drawingCanvas?.nativeElement
    const ctx = canvas?.getContext('2d')
    const dataUrl = this.drawingHistory[this.drawingHistoryIndex]
    if (!canvas || !ctx || !dataUrl) return
    const image = new Image()
    image.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(image, 0, 0)
    }
    image.src = dataUrl
  }

  toggleDrawingFullscreen() {
    this.syncDrawingImage()
    this.isDrawingFullscreen = !this.isDrawingFullscreen
    this.setupDrawingCanvas()
  }

  newDrawing() {
    this.clearDrawingCanvas()
    this.showDrawingMoreMenu = false
    this.queueCoEditAutosave()
  }

  deleteCurrentDrawing() {
    this.clearDrawingCanvas()
    this.images = this.images.filter(image => image.id !== 'drawing')
    this.showDrawingMoreMenu = false
    this.queueCoEditAutosave()
  }

  private clearDrawingCanvas() {
    const canvas = this.drawingCanvas?.nativeElement
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    this.clearDrawingSelection()
    this.pushDrawingHistory()
    this.syncDrawingImage()
  }

  clearDrawingPage() {
    this.clearDrawingCanvas()
    this.showDrawingEraserMenu = false
  }

  exportDrawing() {
    const canvas = this.drawingCanvas?.nativeElement
    if (!canvas) return
    const dataUrl = this.drawingDataUrl(true)
    const link = document.createElement('a')
    link.download = 'kept-drawing.png'
    link.href = dataUrl
    link.click()
    this.showDrawingMoreMenu = false
  }

  private syncDrawingImage() {
    const canvas = this.drawingCanvas?.nativeElement
    if (!canvas) return
    const dataUrl = this.drawingDataUrl()
    const drawing = { id: 'drawing', dataUrl, name: `Drawing|bg:${this.drawingBackground}`, placement: 'top' as const }
    const index = this.images.findIndex(image => image.id === 'drawing')
    if (index >= 0) this.images[index] = drawing
    else this.images = [drawing, ...this.images]
  }

  selectDrawingTool(tool: DrawingTool) {
    if (tool !== 'select') this.clearDrawingSelection()
    this.drawingTool = tool
    this.showDrawingEraserMenu = false
    if (tool === 'eraser') {
      this.drawingOpenToolMenu = undefined
      return
    }
    if (tool === 'select') this.drawingOpenToolMenu = undefined
  }

  toggleDrawingToolMenu(tool: 'pen' | 'marker' | 'highlighter', event: Event) {
    event.stopPropagation()
    this.selectDrawingTool(tool)
    this.drawingOpenToolMenu = this.drawingOpenToolMenu === tool ? undefined : tool
    this.showDrawingBackgroundMenu = false
    this.showDrawingMoreMenu = false
    this.showDrawingEraserMenu = false
  }

  setDrawingToolColor(tool: 'pen' | 'marker' | 'highlighter', color: string) {
    this.drawingToolOptions[tool].color = color
    this.drawingTool = tool
    this.drawingOpenToolMenu = undefined
  }

  setDrawingToolSize(tool: 'pen' | 'marker' | 'highlighter', size: number) {
    this.drawingToolOptions[tool].size = size
    this.drawingTool = tool
    this.drawingOpenToolMenu = undefined
  }

  drawingToolColor(tool: 'pen' | 'marker' | 'highlighter') {
    return this.drawingToolOptions[tool].color
  }

  drawingToolSize(tool: 'pen' | 'marker' | 'highlighter') {
    return this.drawingToolOptions[tool].size
  }

  toggleEraserMenu(event: Event) {
    event.stopPropagation()
    this.selectDrawingTool('eraser')
    this.showDrawingEraserMenu = !this.showDrawingEraserMenu
    this.drawingOpenToolMenu = undefined
    this.showDrawingBackgroundMenu = false
    this.showDrawingMoreMenu = false
  }

  setDrawingBackground(background: 'square' | 'dots' | 'rules' | 'none') {
    this.drawingBackground = background
    this.showDrawingBackgroundMenu = false
    this.syncDrawingImage()
    this.queueCoEditAutosave()
  }

  private drawingBackgroundFromImage(image?: NoteImageI) {
    const match = image?.name?.match(/\|bg:(square|dots|rules|none)$/)
    return (match?.[1] as 'square' | 'dots' | 'rules' | 'none' | undefined) || this.drawingBackground || 'none'
  }

  private drawStoredDrawingImage(ctx: CanvasRenderingContext2D, image: HTMLImageElement) {
    const canvas = ctx.canvas
    const temp = document.createElement('canvas')
    temp.width = image.naturalWidth
    temp.height = image.naturalHeight
    const tempCtx = temp.getContext('2d')!
    tempCtx.drawImage(image, 0, 0)
    const imageData = tempCtx.getImageData(0, 0, temp.width, temp.height)
    const data = imageData.data
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 248 && data[i + 1] > 248 && data[i + 2] > 248) data[i + 3] = 0
    }
    tempCtx.putImageData(imageData, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(temp, 0, 0)
  }

  private drawingDataUrl(withWhiteBackground = false) {
    const canvas = this.drawingCanvas!.nativeElement
    if (!withWhiteBackground) return canvas.toDataURL('image/png')
    const output = document.createElement('canvas')
    output.width = canvas.width
    output.height = canvas.height
    const ctx = output.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, output.width, output.height)
    ctx.drawImage(canvas, 0, 0)
    return output.toDataURL('image/png')
  }

  cboxDrag(event: DragEvent) {
    this.moveCboxDragImage(event)
  }

  cboxDragOver(id: number, isDone: boolean, event: DragEvent) {
    if (this.draggedCboxId === undefined) return
    const draggedCb = this.checkBoxes.find(cb => cb.id === this.draggedCboxId)
    if (!draggedCb || draggedCb.done !== isDone) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    this.moveCboxDragImage(event)
    this.reorderCboxAround(id, isDone, event.clientY)
  }

  cboxTouchStart(id: number, isDone: boolean, event: TouchEvent) {
    if (event.cancelable) event.preventDefault()
    event.stopPropagation()
    const touch = event.touches[0]
    if (!touch) return
    this.cboxTouchStartX = touch.clientX
    this.cboxTouchStartY = touch.clientY
    this.cboxTouchIsDone = isDone
    this.cboxTouchDragging = false
    this.cboxDragOrderChanged = false
    if (this.cboxTouchTimer) clearTimeout(this.cboxTouchTimer)
    this.cboxTouchTimer = setTimeout(() => {
      this.draggedCboxId = id
      this.dragReadyCboxId = id
      this.cboxTouchDragging = true
      const row = document.querySelector<HTMLElement>(`[data-cbox-row-id="${id}"]`)
      if (row) {
        this.createCboxDragImage(row, this.cboxTouchStartX, this.cboxTouchStartY)
        this.moveCboxDragImageToPoint(this.cboxTouchStartX, this.cboxTouchStartY)
      }
      try { (navigator as any).vibrate?.(10) } catch {}
    }, 240)
  }

  cboxTouchMove(event: TouchEvent) {
    const touch = event.touches[0]
    if (!touch) return
    const dx = Math.abs(touch.clientX - this.cboxTouchStartX)
    const dy = Math.abs(touch.clientY - this.cboxTouchStartY)

    if (!this.cboxTouchDragging) {
      if ((dx > 14 || dy > 14) && this.cboxTouchTimer) {
        clearTimeout(this.cboxTouchTimer)
        this.cboxTouchTimer = undefined
      }
      return
    }

    event.preventDefault()
    event.stopPropagation()
    this.moveCboxDragImageToPoint(touch.clientX, touch.clientY)
    const row = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('[data-cbox-row-id]') as HTMLElement | null
    const id = Number(row?.dataset['cboxRowId'])
    if (Number.isNaN(id)) return
    this.reorderCboxAround(id, this.cboxTouchIsDone, touch.clientY)
  }

  cboxTouchEnd() {
    if (this.cboxTouchTimer) {
      clearTimeout(this.cboxTouchTimer)
      this.cboxTouchTimer = undefined
    }
    if (this.cboxTouchDragging) this.persistCboxDragOrder()
    this.clearCboxDragState()
    this.cboxTouchDragging = false
  }

  private reorderCboxAround(id: number, isDone: boolean, clientY: number) {
    if (this.draggedCboxId === undefined) return
    const draggedCb = this.checkBoxes.find(cb => cb.id === this.draggedCboxId)
    if (!draggedCb || draggedCb.done !== isDone) return
    if (id === this.draggedCboxId) return

    const row = document.querySelector<HTMLElement>(`[data-cbox-row-id="${id}"]`)
    if (!row) return
    const rect = row.getBoundingClientRect()
    const placement: 'before' | 'after' = clientY < rect.top + rect.height / 2 ? 'before' : 'after'

    const fromIdx = this.checkBoxes.indexOf(draggedCb)
    const targetIdx = this.checkBoxes.findIndex(cb => cb.id === id)
    if (fromIdx < 0 || targetIdx < 0) return

    // Cheap early-out: figure out the destination index without touching the
    // array, and bail if it'd be a no-op. dragover fires dozens of times per
    // second even when the cursor hasn't crossed a row midpoint, so doing
    // the splice + Angular change detection + FLIP-style row animations on
    // every event is what was causing the lag.
    const insertBeforeIdx = placement === 'after' ? targetIdx + 1 : targetIdx
    const adjustedInsertIdx = insertBeforeIdx > fromIdx ? insertBeforeIdx - 1 : insertBeforeIdx
    if (adjustedInsertIdx === fromIdx) return

    const previousRects = this.getCboxRowRects(isDone)
    const [moved] = this.checkBoxes.splice(fromIdx, 1)
    this.checkBoxes.splice(adjustedInsertIdx, 0, moved)
    this.checkBoxes = [...this.checkBoxes]
    this.animateCboxRows(previousRects, this.draggedCboxId)
    this.cboxDragOrderChanged = true
  }

  cboxDrop(id: number, isDone: boolean, event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (this.draggedCboxId === undefined) return
    const draggedCb = this.checkBoxes.find(cb => cb.id === this.draggedCboxId)
    if (!draggedCb || draggedCb.done !== isDone) return
    this.persistCboxDragOrder()
    this.clearCboxDragState()
  }

  cboxDragEnd() {
    this.persistCboxDragOrder()
    this.clearCboxDragState()
  }

  private persistCboxDragOrder() {
    if (!this.cboxDragOrderChanged || !this.isEditing || !this.noteToEdit.id) return
    this.noteToEdit.checkBoxes = this.checkBoxes
    this.saveBaselineSnapshot = this.noteSaveSnapshot({ ...this.noteToEdit, checkBoxes: this.checkBoxes })
    this.notesService.updateKey({ checkBoxes: this.checkBoxes }, this.noteToEdit.id)
  }

  private clearCboxDragState() {
    if (this.cboxTouchTimer) {
      clearTimeout(this.cboxTouchTimer)
      this.cboxTouchTimer = undefined
    }
    this.draggedCboxId = undefined
    this.dragReadyCboxId = undefined
    this.cboxDragOrderChanged = false
    this.cboxDragImage?.remove()
    this.cboxDragImage = undefined
  }

  private createCboxDragImage(row: HTMLElement, clientX: number, clientY: number) {
    this.cboxDragImage?.remove()
    const rect = row.getBoundingClientRect()
    const dragImage = row.cloneNode(true) as HTMLElement
    dragImage.classList.add('cbox-drag-image')
    dragImage.removeAttribute('data-cbox-row-id')
    dragImage.style.width = `${rect.width}px`
    dragImage.style.transform = `translate(${rect.left}px, ${rect.top}px)`
    document.body.appendChild(dragImage)
    this.cboxDragImage = dragImage
    this.cboxDragImageOffset = { x: clientX - rect.left, y: clientY - rect.top }
  }

  private moveCboxDragImage(event: DragEvent) {
    if (!this.cboxDragImage || (event.clientX === 0 && event.clientY === 0)) return
    this.moveCboxDragImageToPoint(event.clientX, event.clientY)
  }

  private moveCboxDragImageToPoint(clientX: number, clientY: number) {
    if (!this.cboxDragImage) return
    this.cboxDragImage.style.transform = `translate(${clientX - this.cboxDragImageOffset.x}px, ${clientY - this.cboxDragImageOffset.y}px)`
  }

  private getTransparentDragImage() {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    return canvas
  }

  private getCboxRowRects(isDone: boolean) {
    const rects = new Map<number, DOMRect>()
    document.querySelectorAll<HTMLElement>('[data-cbox-row-id]').forEach(row => {
      const id = Number(row.dataset['cboxRowId'])
      const cb = this.checkBoxes.find(item => item.id === id)
      if (cb?.done === isDone) rects.set(id, row.getBoundingClientRect())
    })
    return rects
  }

  private animateCboxRows(previousRects: Map<number, DOMRect>, draggedId: number) {
    this.cd.detectChanges()
    requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>('[data-cbox-row-id]').forEach(row => {
        const id = Number(row.dataset['cboxRowId'])
        if (id === draggedId) return

        const previousRect = previousRects.get(id)
        if (!previousRect) return

        const nextRect = row.getBoundingClientRect()
        const deltaY = previousRect.top - nextRect.top
        if (!deltaY) return

        // Cancel any in-flight FLIP animation on this row so successive
        // reorders during a fast drag don't queue overlapping animations
        // (which is what made the drag feel laggy).
        for (const anim of row.getAnimations()) {
          if ((anim as any).id === 'cbox-flip') anim.cancel()
        }
        const animation = row.animate(
          [
            { transform: `translateY(${deltaY}px)` },
            { transform: 'translateY(0)' }
          ],
          {
            duration: 140,
            easing: 'cubic-bezier(0.2, 0, 0, 1)'
          }
        )
        ;(animation as any).id = 'cbox-flip'
      })
    })
  }

  cboxTools(id: number) {
    let i = this.checkBoxes.findIndex(x => x.id === id)
    let actions = {
      remove: () => {
        this.checkBoxes.splice(i, 1)
        this.inputLength.next({ ...this.inputLength.value, cb: this.checkBoxes.length })
        this.queueCoEditAutosave()
      },
      check: () => {
        this.checkBoxes[i].done = !this.checkBoxes[i].done
        this.queueCoEditAutosave()
      },
      update: (el: HTMLDivElement) => {
        let elValue = el?.innerHTML
        this.checkBoxes[i].data = elValue
        this.queueCoEditAutosave()
      }
    }
    return actions
  }

  toggleCboxDone(id: number, event?: Event) {
    event?.preventDefault()
    event?.stopPropagation()
    if (event?.type === 'touchend') {
      this.lastCboxTouchToggleAt = Date.now()
    } else if (Date.now() - this.lastCboxTouchToggleAt < 700) {
      return
    }
    if (!this.checkBoxes.some(cb => cb.id === id)) return
    this.cboxTools(id).check()
    this.noteToEdit.checkBoxes = this.checkBoxes
    this.cd.detectChanges()
  }

  //? isEditing  -----------------------------------------------------------

  innerData(note: NoteI) {
    this.notePhClick()
    this.noteTitle.nativeElement.innerHTML = note.noteTitle
    this.images = (note.images || []).map(image => ({ ...image, dataUrl: this.auth.authenticatedImageUrl(image.dataUrl) }))
    this.attachments = note.attachments || []
    this.isDrawingNote = this.images.some(image => image.id === 'drawing')
    this.notePin.nativeElement.dataset['pinned'] = String(note.pinned)
    this.applyBackgroundImage(note.bgImage)
    // applyBackgroundImage already sets this.hasBackgroundImage with the
    // correct logic (treats empty `url("")` as "no image"); do not override it.
    this.noteMain.nativeElement.style.backgroundColor = note.bgColor
    this.noteMain.nativeElement.style.borderColor = note.bgColor
    this.updateTextColor(note.bgColor)
    this.checkBoxes = JSON.parse(JSON.stringify(note.checkBoxes || []))
    // Hybrid: latch BEFORE flipping isCbox so the noteBody ViewChild is
    // present after change detection (otherwise the body assignment below
    // would silently no-op when loading a hybrid note from a checklist-only
    // previous editor state).
    this.isHybridNote = !!note.isCbox && this.hasMeaningfulBody(note.noteBody)
    this.isCbox.next(note.isCbox)
    this.isArchived = note.archived
    this.isTrashed = note.trashed
    this.saveBaselineSnapshot = this.noteSaveSnapshot(note)
    //
    this.inputLength.next({ title: note.noteTitle.length, body: (note.noteBody ? note.noteBody?.length : 0) + this.images.length + this.attachments.length, cb: note.checkBoxes?.length! })
    note.labels.forEach(noteLabel => {
      let label = this.labels.find(x => x.name === noteLabel.name)
      if (label) label.added = noteLabel.added
    })
    this.labelsDirty = false
    // Force the templates to materialize before we touch the body element.
    this.cd.detectChanges()
    if (this.noteBody) this.noteBody.nativeElement.innerHTML = this.decorateLinksForEditor(note.noteBody || '')
    this.hydrateEditorLinkPreviews()
    this.hydrateInlineImageButtons()
    if (this.isDrawingNote) this.setupDrawingCanvas()
  }

  //? tooltip  -----------------------------------------------------------

  openTooltip(button: HTMLDivElement, tooltipEl: HTMLDivElement) {
    this.Shared.createTooltip(button, tooltipEl)
  }

  async openCollaboratorMenu(button: HTMLDivElement, tooltipEl: HTMLDivElement) {
    if (!this.isEditing || !this.noteToEdit.id) return
    this.Shared.note.id = this.noteToEdit.id
    this.collaboratorError = ''
    this.collaboratorUsers = []
    this.selectedCollaboratorIds = (this.noteToEdit.collaborators || []).map(user => user.id)
    this.Shared.createTooltip(button, tooltipEl)

    try {
      this.collaboratorUsers = await this.Shared.note.db.listShareUsers()
      if (this.canManageCollaborators()) {
        const collaborators = await this.notesService.getCollaborators(this.noteToEdit.id!)
        this.selectedCollaboratorIds = collaborators.map(user => user.id)
      }
    } catch (error: any) {
      this.collaboratorError = error?.error?.error || 'Could not load sharing options.'
    }
  }

  canManageCollaborators() {
    return !!this.noteToEdit.id && this.noteToEdit.ownerUserId === this.auth.currentUser?.id
  }

  isNoteOwner(userId: number) {
    return !!this.noteToEdit.ownerUserId && this.noteToEdit.ownerUserId === userId
  }

  isCollaboratorSelected(userId: number) {
    return this.selectedCollaboratorIds.includes(userId)
  }

  async toggleCollaborator(userId: number) {
    if (!this.canManageCollaborators()) return
    const previousSelectedIds = [...this.selectedCollaboratorIds]
    if (this.isCollaboratorSelected(userId)) {
      this.selectedCollaboratorIds = this.selectedCollaboratorIds.filter(id => id !== userId)
    } else {
      this.selectedCollaboratorIds = [...this.selectedCollaboratorIds, userId]
    }

    this.isSavingCollaborators = true
    this.collaboratorError = ''
    try {
      const collaborators = await this.notesService.updateCollaborators(this.noteToEdit.id!, this.selectedCollaboratorIds)
      this.noteToEdit.collaborators = collaborators
      this.selectedCollaboratorIds = collaborators.map(user => user.id)
    } catch (error: any) {
      this.selectedCollaboratorIds = previousSelectedIds
      this.collaboratorError = error?.error?.error || 'Could not update collaborators.'
    } finally {
      this.isSavingCollaborators = false
    }
  }

  async saveCollaborators(tooltipEl: HTMLDivElement) {
    if (!this.canManageCollaborators()) return
    this.isSavingCollaborators = true
    this.collaboratorError = ''
    try {
      const collaborators = await this.notesService.updateCollaborators(this.noteToEdit.id!, this.selectedCollaboratorIds)
      this.noteToEdit.collaborators = collaborators
      this.Shared.closeTooltip(tooltipEl)
    } catch (error: any) {
      this.collaboratorError = error?.error?.error || 'Could not save collaborators.'
    } finally {
      this.isSavingCollaborators = false
    }
  }

  async addLabelFromMenu(input: HTMLInputElement) {
    const name = input.value.trim()
    if (!name) return

    const existing = this.labels.find(label => label.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      existing.added = true
      this.labelsDirty = true
      input.value = ''
      this.labelMenuError = ''
      return
    }

    try {
      const id = await this.Shared.label.db.add({ name })
      this.labels = [{ id, name, added: true }, ...this.labels]
      this.labelsDirty = true
      input.value = ''
      this.labelMenuError = ''
    } catch (error: any) {
      const matchingLabel = this.Shared.label.list.find(label => label.name.toLowerCase() === name.toLowerCase())
      if (matchingLabel) {
        this.labels = [{ ...matchingLabel, added: true }, ...this.labels]
        this.labelsDirty = true
        input.value = ''
        this.labelMenuError = ''
        return
      }
      this.labelMenuError = error?.status === 409 ? 'Label already exists' : 'Could not create label'
    }
  }

  toggleLabel(label: LabelI) {
    label.added = !label.added
    this.labelsDirty = true
  }

  isSharedNoteForCurrentUser() {
    const ownerId = this.noteToEdit?.ownerUserId
    const me = this.auth.currentUser?.id
    return !!(ownerId && me && ownerId !== me)
  }

  moreMenu(tooltipEl: HTMLDivElement) {
    let actions = {
      trash: () => {
        if (this.isEditing) {
          // Shared note: the viewer is not the owner. They can't delete it,
          // only unshare themselves from it. Mirrors notes.component's
          // moreMenu.trash so behaviour is consistent across views.
          if (this.isSharedNoteForCurrentUser()) {
            const ownerName = this.noteToEdit.ownerDisplayName || this.noteToEdit.ownerUsername || 'the owner'
            const ok = confirm(`This note belongs to ${ownerName}, so you can't delete it — only the owner can. Remove yourself from this shared note instead?`)
            if (!ok) return
            const userId = this.auth.currentUser?.id
            this.notesService.delete(this.noteToEdit.id!)
            this.Shared.snackBar({ action: 'left shared note', opposite: 'rejoined' }, { rejoin: true, userId } as any, this.noteToEdit.id!)
            this.Shared.closeModal.next(true)
            return
          }
          this.Shared.note.db.trash()
          this.Shared.closeModal.next(true)
        } else {
          this.isTrashed = true
          this.saveNote()
        }
      },
      clone: () => {
        this.saveNote()
      },
      toggleCbox: () => {
        this.toggleCbox()
      }
    }
    this.Shared.closeTooltip(tooltipEl)
    return actions
  }

  colorMenu = {
    bgColor: (data: bgColors) => {
      this.noteMain.nativeElement.style.backgroundColor = data
      this.noteMain.nativeElement.style.borderColor = data
      this.updateTextColor(data)
      this.queueCoEditAutosave()
    },
    bgImage: (data: bgImages) => {
      this.applyBackgroundImage(data)
      this.queueCoEditAutosave()
    }
  }

  private applyBackgroundImage(data: string) {
    const bgImage = data ? (data.startsWith('url(') ? data : `url(${data})`) : ''
    this.noteContainer.nativeElement.style.backgroundImage = bgImage
    this.noteMain.nativeElement.style.backgroundImage = bgImage
    this.hasBackgroundImage = !!bgImage && bgImage !== 'url("")'
    this.updateTextColor(this.noteMain.nativeElement.style.backgroundColor)
  }

  private updateTextColor(color: string) {
    if (this.hasBackgroundImage || this.isLightColor(color)) {
      this.noteMain.nativeElement.style.color = '#202124'
    } else if (color) {
      this.noteMain.nativeElement.style.color = '#e8eaed'
    } else {
      this.noteMain.nativeElement.style.color = ''
    }
  }

  isLightColor(color: string) {
    const rgb = this.parseColor(color)
    if (!rgb) return false
    return ((rgb.r * 299) + (rgb.g * 587) + (rgb.b * 114)) / 1000 > 160
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

  //?  -----------------------------------------------------------
  // cuz we don't have the spread operator in the template, we need to do this : 
  updateInputLength(type: InputLengthI) {
    if (type.title != undefined) this.inputLength.next({ ...this.inputLength.value, title: type.title })
    if (type.body != undefined) this.inputLength.next({ ...this.inputLength.value, body: type.body })
  }


  //? -----------------------------------------------------------

  saveNoteSubscription?: Subscription
  ngAfterViewInit() {
    this.mobileComposerSubscription = this.Shared.openMobileComposer.subscribe(open => {
      if (open) this.openMobileComposer()
    })
    if (this.isEditing) { this.saveNoteSubscription = this.Shared.saveNote.subscribe(x => { if (x) this.saveNote() }) }
    if (this.isEditing && this.noteToEdit.id) {
      this.notesService.joinNote(this.noteToEdit.id);
      this.coEditSubscription = this.notesService.activeEditors$.subscribe(data => {
        if (data && data.noteId === this.noteToEdit.id) {
          this.activeEditors = (data.editors || []).filter((e: any) => e.id !== this.auth.currentUser?.id);
        }
      });
      this.autoSaveSubscription = this.autoSaveSubject.pipe(debounceTime(550)).subscribe(() => {
        if (this.activeEditors.length > 0) {
          this.saveNote(false);
        }
      });
      this.notesListSubscription = this.notesService.notesList$.subscribe(notes => {
        if (!notes || this.activeEditors.length === 0) return;
        const updatedNote = notes.find(n => n.id === this.noteToEdit.id);
        if (updatedNote) {
          this.applyExternalUpdate(updatedNote);
        }
      });
    }
    //? ----------------------------------------------------------------
    this.isCbox.subscribe(value => {
      this.updateCheckboxMenuLabel()
    })
    //? ----------------------------------------------------------------
    this.inputLength.subscribe(x => {
      if ((x.title) || (x.body) || (x.cb)) {
        this.moreMenuEls.delete.disabled = false
        this.moreMenuEls.copy.disabled = false
      } else {
        this.moreMenuEls.delete.disabled = true
        this.moreMenuEls.copy.disabled = true
      }
    })
    if (this.isEditing) {
      this.innerData(this.noteToEdit)
    }
    if (this.autoOpenImagePicker) {
      setTimeout(() => this.openImagePicker(), 0)
    }
  }

  ngOnInit(): void {
    if (this.isEditing && this.noteToEdit) {
      this.updateLastEditedTime();
      if (window.innerWidth < 660) {
        this.mobileComposeMode = true;
        this.lockBodyScroll();
      }
    }
    this.bindKeyboardOffset();
  }

  // Prevent the document body from rubber-banding/scrolling underneath the
  // mobile fullscreen compose modal — without this, scrolling the editor
  // content can hand touch events off to the body and cause the underlying
  // notes grid to peek-and-bounce behind the open editor.
  private bodyScrollLocked = false;
  private lockedBodyScrollY = 0;
  private lockBodyScroll() {
    if (this.bodyScrollLocked) return;
    this.bodyScrollLocked = true;
    this.lockedBodyScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = `-${this.lockedBodyScrollY}px`;
    document.body.classList.add('kept-mobile-compose-open');
  }
  private unlockBodyScroll() {
    if (!this.bodyScrollLocked) return;
    const scrollY = this.lockedBodyScrollY;
    this.bodyScrollLocked = false;
    document.body.classList.remove('kept-mobile-compose-open');
    document.body.style.top = '';
    window.scrollTo(0, scrollY);
    this.lockedBodyScrollY = 0;
  }

  // Track the soft-keyboard height on mobile so the sticky bottom toolbar can
  // float above it instead of being hidden behind it.
  private viewportListener?: () => void;
  private bindKeyboardOffset() {
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    if (!vv) return;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--keyboard-offset', `${offset}px`);
    };
    this.viewportListener = update;
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
  }

  private unbindKeyboardOffset() {
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    if (!vv || !this.viewportListener) return;
    vv.removeEventListener('resize', this.viewportListener);
    vv.removeEventListener('scroll', this.viewportListener);
    document.documentElement.style.removeProperty('--keyboard-offset');
    this.viewportListener = undefined;
  }

  private updateLastEditedTime() {
    if (!this.noteToEdit.updatedAt) {
      this.lastEditedTime = 'just now';
      return;
    }
    const date = new Date(this.noteToEdit.updatedAt);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    
    let timeStr = '';
    if (isToday) {
      timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } else {
      timeStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    if (this.noteToEdit.lastEditorUserId && this.noteToEdit.lastEditorUserId !== this.auth.currentUser?.id) {
      this.lastEditedTime = `Edited ${timeStr}, by ${this.noteToEdit.lastEditorDisplayName}`;
    } else {
      this.lastEditedTime = `Edited ${timeStr}`;
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.editorPreviewGeneration++;
    if (this.editorLinkDecorationFrame) {
      cancelAnimationFrame(this.editorLinkDecorationFrame);
      this.editorLinkDecorationFrame = undefined;
    }
    this.saveNoteSubscription?.unsubscribe();
    if (this.isEditing && this.noteToEdit.id) {
      this.notesService.leaveNote(this.noteToEdit.id);
    }
    this.coEditSubscription?.unsubscribe();
    this.notesListSubscription?.unsubscribe();
    this.autoSaveSubscription?.unsubscribe();
    this.mobileComposerSubscription?.unsubscribe();
    this.unbindKeyboardOffset();
    this.unbindAndroidBackgroundLocationResume();
    this.unlockBodyScroll();
  }

  applyExternalUpdate(note: NoteI) {
    if (this.noteTitle?.nativeElement && this.noteTitle.nativeElement.innerHTML !== note.noteTitle) {
      this.updateHtmlWithCursorPreservation(this.noteTitle.nativeElement, note.noteTitle);
    }
    const nextBody = note.noteBody !== undefined ? this.decorateLinksForEditor(note.noteBody || '') : undefined;
    if (this.noteBody?.nativeElement && nextBody !== undefined && this.noteBody.nativeElement.innerHTML !== nextBody) {
      this.updateHtmlWithCursorPreservation(this.noteBody.nativeElement, nextBody);
    }
    if (this.noteMain?.nativeElement) {
      this.noteMain.nativeElement.style.backgroundColor = note.bgColor || "";
      if (note.bgImage) {
        this.noteMain.nativeElement.style.backgroundImage = note.bgImage;
      }
    }
    if (!this.cboxDragImage) {
      this.checkBoxes = JSON.parse(JSON.stringify(note.checkBoxes || []));
    }
    const oldDrawing = this.images.find(i => i.id === 'drawing');
    this.images = (note.images || []).map(image => ({ ...image, dataUrl: this.auth.authenticatedImageUrl(image.dataUrl) }));
    this.attachments = note.attachments || [];
    const newDrawing = this.images.find(i => i.id === 'drawing');
    if (this.isDrawingNote && newDrawing && newDrawing.dataUrl !== oldDrawing?.dataUrl) {
      this.drawingHistory = [newDrawing.dataUrl];
      this.drawingHistoryIndex = 0;
      this.restoreDrawingHistory();
    }
    this.isHybridNote = !!note.isCbox && this.hasMeaningfulBody(note.noteBody);
    this.isCbox.next(note.isCbox);
    this.cd.detectChanges();
  }

  updateHtmlWithCursorPreservation(element: HTMLElement, newHtml: string) {
    const selection = window.getSelection();
    let savedOffset = 0;
    let hasFocus = document.activeElement === element;
    
    if (hasFocus && selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const preSelectionRange = range.cloneRange();
      preSelectionRange.selectNodeContents(element);
      preSelectionRange.setEnd(range.startContainer, range.startOffset);
      savedOffset = preSelectionRange.toString().length;
    }
    
    element.innerHTML = newHtml;
    
    if (hasFocus && selection) {
      let charIndex = 0;
      const range = document.createRange();
      range.setStart(element, 0);
      range.collapse(true);
      
      const nodeStack: Node[] = [element];
      let node;
      let foundStart = false;
      
      while (!foundStart && (node = nodeStack.pop())) {
        if (node.nodeType === 3) {
          const nextCharIndex = charIndex + (node.textContent?.length || 0);
          if (!foundStart && savedOffset >= charIndex && savedOffset <= nextCharIndex) {
            range.setStart(node, savedOffset - charIndex);
            range.setEnd(node, savedOffset - charIndex);
            foundStart = true;
          }
          charIndex = nextCharIndex;
        } else {
          let i = node.childNodes.length;
          while (i--) {
            nodeStack.push(node.childNodes[i]);
          }
        }
      }
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  deleteImage(image: any) {
    this.images = this.images.filter(img => img.id !== image.id)
    this.queueCoEditAutosave()
  }

  getActiveReminder() {
    if (this.pendingReminderDate) {
      return { dueAtUtc: this.pendingReminderDate.toISOString() }
    }
    if (this.pendingReminderLocation) {
      return { locationName: this.pendingReminderLocation.locationName }
    }
    if (!this.isEditing || !this.noteToEdit.id) return null
    return this.reminderService.reminders$.value.find(r => r.noteId === this.noteToEdit.id && r.status === 'pending')
  }

  @ViewChild('alarmDateInp') customDateInp?: ElementRef<HTMLInputElement>
  @ViewChild('customTimeInp') customTimeInp?: ElementRef<HTMLInputElement>

  alarmIconTapped(event: Event) {
    event.stopPropagation()

    // iOS Safari requires Notification.requestPermission() to be invoked
    // synchronously inside a user gesture. Fire it on this tap so the
    // gesture token is still alive when iOS asks.
    this.promptForNotificationPermission()

    // If a reminder already exists, toggle the inline "Remove reminder"
    // panel — there's no overlaid date input in that case.
    if (this.getActiveReminder()) {
      if (this.showReminderPicker) {
        this.closeReminderPicker()
      } else {
        this.showReminderPicker = true
        document.removeEventListener('mousedown', this.pickerOutsideHandler)
        setTimeout(() => document.addEventListener('mousedown', this.pickerOutsideHandler), 0)
      }
      return
    }

    if (this.keptPlugins.supportsNativeLocationReminders) {
      this.openReminderTypeDialog()
      return
    }

    this.customDate = ''
    this.customTime = ''
    this.calendarMonth = this.startOfMonth(new Date())
    this.destroyTimePicker()
    this.showReminderDateDialog = true
  }

  openReminderTypeDialog() {
    this.showReminderPicker = false
    this.showReminderTypeDialog = true
    this.showReminderDateDialog = false
    this.showReminderLocationDialog = false
    this.customDate = ''
    this.customTime = ''
    this.calendarMonth = this.startOfMonth(new Date())
    this.destroyTimePicker()
    this.resetLocationState()
    document.removeEventListener('mousedown', this.pickerOutsideHandler)
    setTimeout(() => document.addEventListener('mousedown', this.pickerOutsideHandler), 0)
  }

  chooseReminderDateTime() {
    this.showReminderTypeDialog = false
    this.showReminderDateDialog = true
  }

  chooseReminderPlace() {
    this.showReminderTypeDialog = false
    this.showReminderLocationDialog = true
    this.openPlaceChooser()
  }

  cancelReminderType() {
    this.closeReminderPicker()
  }

  private openDateThenTimeFlow(trigger?: HTMLElement | null) {
    this.customDate = ''
    this.customTime = ''
    this.destroyTimePicker()

    const dateInput = this.customDateInp?.nativeElement
    if (!dateInput) return

    dateInput.value = ''
    const minDate = new Date()
    minDate.setHours(0, 0, 0, 0)
    dateInput.min = this.formatLocalDateInput(minDate)

    // Anchor the system picker next to the alarm icon that triggered it,
    // not at the input's CSS position. Without this, Chrome/Firefox render
    // the calendar at the off-screen input location (top-left of the modal
    // in our case), and iOS sometimes refuses to open it at all.
    this.positionPickerInput(dateInput, trigger || null)

    try {
      if (typeof (dateInput as any).showPicker === 'function') {
        (dateInput as any).showPicker()
      } else {
        dateInput.focus()
        dateInput.click()
      }
    } catch {
      dateInput.focus()
    }
  }

  // Two-stage confirmation flow: tapping the alarm icon opens the system
  // date picker. When the user picks a date the input's `change` event
  // fires — but instead of auto-progressing to the time picker (which on
  // iOS happens too eagerly when the user just dismisses the wheel), we
  // surface a small "Pick time" button. The user explicitly confirms by
  // tapping it, which then opens the time picker. This avoids the iOS
  // Safari behaviour of committing the wheel's default value on dismiss.
  pendingDateConfirm: { dateInput: HTMLInputElement; timeInput: HTMLInputElement; date: string } | null = null

  onAlarmDateFocus(_input: HTMLInputElement) {}
  onAlarmDateBlur(_input: HTMLInputElement, _timeInput: HTMLInputElement) {}

  onAlarmDateInputChange(input: HTMLInputElement, timeInput: HTMLInputElement) {
    if (!input.value) {
      this.pendingDateConfirm = null
      return
    }
    this.customDate = input.value
    this.pendingDateConfirm = { dateInput: input, timeInput, date: input.value }
  }

  confirmPendingDate() {
    const p = this.pendingDateConfirm
    if (!p) return
    this.pendingDateConfirm = null
    this.createTimePicker(p.dateInput, p.timeInput)
    this.customTimePicker?.open()
  }

  cancelPendingDate() {
    if (this.pendingDateConfirm) {
      this.pendingDateConfirm.dateInput.value = ''
    }
    this.pendingDateConfirm = null
    this.customDate = ''
  }

  formatPendingDateLabel(iso: string): string {
    if (!iso) return ''
    const [y, m, d] = iso.split('-').map(Number)
    if (!y || !m || !d) return iso
    const date = new Date(y, m - 1, d)
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  }

  // Legacy passthrough for any callers still wired to onGlobalDateChange.
  onGlobalDateChange(dateInput: HTMLInputElement, timeInput: HTMLInputElement) {
    this.onAlarmDateInputChange(dateInput, timeInput)
  }

  private formatLocalDateInput(date: Date) {
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }

  todayDateInput() {
    const minDate = new Date()
    minDate.setHours(0, 0, 0, 0)
    return this.formatLocalDateInput(minDate)
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

  confirmReminderDate(timeInput: HTMLInputElement) {
    if (!this.customDate) return
    this.showReminderDateDialog = false
    this.createTimePicker(null, timeInput)
    this.customTimePicker?.open()
  }

  cancelReminderDate() {
    this.customDate = ''
    this.showReminderDateDialog = false
  }

  private positionPickerInput(input: HTMLInputElement, trigger: HTMLElement | null) {
    if (!trigger) {
      input.style.left = '50%'
      input.style.top = '50%'
      return
    }
    const rect = trigger.getBoundingClientRect()
    input.style.left = `${Math.max(0, rect.left)}px`
    input.style.top = `${Math.max(0, rect.bottom)}px`
  }

  closeReminderPicker() {
    this.showReminderPicker = false
    this.showReminderTypeDialog = false
    this.showReminderDateDialog = false
    this.showReminderLocationDialog = false
    this.resetLocationState()
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
    const picker = document.querySelector('.reminder-picker, .reminder-date-dialog')
    const isTimePickerClick = target.closest('.tp-ui-modal') || target.closest('.tp-ui-wrapper')
    if (picker && !picker.contains(target) && !isTimePickerClick) {
      this.closeReminderPicker()
    }
  }

  setReminder(date: Date) {
    // Backup prompt for users who skipped the picker open (e.g. via custom
    // date input). Permission was already requested when the picker opened.
    this.promptForNotificationPermission()
    if (this.isEditing && this.noteToEdit.id) {
      const existing = this.getActiveReminder()
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (existing && (existing as any).id) {
        this.reminderService.update((existing as any).id, { dueAtUtc: date.toISOString(), status: 'pending' })
          .then(result => { if (!result) this.showReminderSaveError() })
          .catch(() => this.showReminderSaveError())
      } else {
        this.reminderService.create({
          noteId: this.noteToEdit.id,
          dueAtUtc: date.toISOString(),
          timezone: tz,
          title: this.notePlainText(this.noteToEdit.noteTitle),
          body: this.notePlainText(this.noteToEdit.noteBody)
        }).then(result => { if (!result) this.showReminderSaveError() })
          .catch(() => this.showReminderSaveError())
      }
    } else {
      // For new notes, store locally until save
      this.pendingReminderDate = date
    }
    this.closeReminderPicker()
    this.cd.detectChanges()
  }

  confirmCustom(dateInp: HTMLInputElement | null, timeInp: HTMLInputElement) {
    // Prefer our stored state over the raw input value to avoid race conditions
    const d = dateInp?.value || this.customDate
    const t = this.toTwentyFourHourTime(this.customTime || timeInp.value)
    
    if (!d || !t) return
    this.closeReminderPicker()
    this.customPickerOpen = false
    this.setReminder(new Date(`${d}T${t}`))
  }

  async clearReminder(event: Event) {
    event.stopPropagation()
    if (this.pendingReminderDate || this.pendingReminderLocation) {
      this.pendingReminderDate = null
      this.pendingReminderLocation = null
      this.pendingAndroidLocationReminder = null
      this.showAndroidBackgroundLocationEducation = false
      this.androidBackgroundLocationMessage = ''
      this.unbindAndroidBackgroundLocationResume()
      this.closeReminderPicker()
      this.cd.detectChanges()
      return
    }
    if (this.isEditing && this.noteToEdit.id) {
      const existing = this.getActiveReminder()
      if (existing && (existing as any).id) await this.reminderService.delete((existing as any).id)
    } else {
      this.pendingReminderDate = null
      this.pendingReminderLocation = null
    }
    this.closeReminderPicker()
    this.cd.detectChanges()
  }

  private createTimePicker(dateInput: HTMLInputElement | null, timeInput: HTMLInputElement) {
    if (this.customTimePicker && this.customTimePickerInput === timeInput) {
      this.timePickerDateInput = dateInput || this.timePickerDateInput
      return
    }
    this.destroyTimePicker()
    this.timePickerDateInput = dateInput || undefined
    this.customTimePickerInput = timeInput
    timeInput.value = this.customTime || this.currentTimeValue()
    this.customTimePicker = new TimepickerUI(timeInput, {
      clock: { currentTime: { time: new Date(), updateInput: true } },
      ui: { editable: false },
      callbacks: {
        onOpen: () => {
        },
        onConfirm: (data: ConfirmEventData) => {
          this.zone.run(() => {
            const hour = String(data.hour || '00').padStart(2, '0')
            const minutes = String(data.minutes || '00').padStart(2, '0')
            const period = data.type ? ` ${data.type}` : ''
            this.customTime = `${hour}:${minutes}${period}`
            const dInp = this.timePickerDateInput
            if (dInp?.value || this.customDate) {
              setTimeout(() => this.confirmCustom(dInp || null, timeInput), 0)
            }
          })
        }
      }
    })
    this.customTimePicker.create()
  }

  private timePickerDateInput?: HTMLInputElement

  private destroyTimePicker() {
    this.customTimePicker?.destroy({ keepInputValue: true })
    this.customTimePicker = undefined
    this.customTimePickerInput = undefined
  }

  private toTwentyFourHourTime(value: string) {
    if (!value) return ''
    const time = value.trim().toUpperCase().replace(/\./g, '') // handle p.m. -> PM
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

  private currentTimeValue() {
    return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  inHours(n: number): Date { return new Date(Date.now() + n * 60 * 60 * 1000) }
  tomorrow(): Date { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d }
  nextWeek(): Date { const d = new Date(); const daysUntilMonday = ((8 - d.getDay()) % 7) || 7; d.setDate(d.getDate() + daysUntilMonday); d.setHours(9, 0, 0, 0); return d }
  formatReminderDate(isoString: string): string { return new Date(isoString).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }

  // ─── Location reminders ───────────────────────────────────────────────

  async openPlaceChooser() {
    this.placeDialogView = 'choose'
    this.resetLocationState()
    this.savedPlacesSearch = ''
    this.locationTrigger = 'arrive'
    await Promise.all([this.loadSavedPlaces(), this.loadCurrentLocation()])
  }

  backFromPlaceDialog() {
    if (this.placeDialogView !== 'choose') {
      this.openPlaceChooser()
      return
    }
    this.showReminderLocationDialog = false
    this.showReminderTypeDialog = true
  }

  async loadSavedPlaces() {
    this.savedPlacesLoading = true
    this.savedPlacesError = ''
    try {
      this.savedPlaces = await this.savedPlacesService.list()
    } catch {
      this.savedPlacesError = 'Saved places could not load.'
    } finally {
      this.savedPlacesLoading = false
      this.cd.detectChanges()
    }
  }

  visiblePlaceItems(): PlaceListItem[] {
    const q = this.savedPlacesSearch.trim().toLowerCase()
    const items: PlaceListItem[] = [...this.savedPlaces]
    if (!this.savedPlaces.some(place => place.placeType === 'home')) {
      items.push({ id: 'home-prompt', name: 'Home', address: 'Add your home address', placeType: 'home', prompt: true })
    }
    if (!this.savedPlaces.some(place => place.placeType === 'work')) {
      items.push({ id: 'work-prompt', name: 'Work', address: 'Add your work address', placeType: 'work', prompt: true })
    }
    if (!q) return items
    return items.filter(place =>
      place.name.toLowerCase().includes(q) ||
      (place.address || '').toLowerCase().includes(q)
    )
  }

  visibleSavedPlaces() {
    const q = this.savedPlacesSearch.trim().toLowerCase()
    if (!q) return this.savedPlaces
    return this.savedPlaces.filter(place =>
      place.name.toLowerCase().includes(q) ||
      (place.address || '').toLowerCase().includes(q)
    )
  }

  placeIcon(placeType: SavedPlaceType) {
    switch (placeType) {
      case 'home': return 'home'
      case 'work': return 'business_center'
      case 'gym': return 'fitness_center'
      default: return 'location_on'
    }
  }

  placeDistanceLabel(place: PlaceListItem) {
    if ('prompt' in place) return ''
    if (this.currentLocationLoading && !this.currentLocation) return '...'
    if (!this.currentLocation) return ''
    const meters = this.distanceMeters(
      this.currentLocation.latitude,
      this.currentLocation.longitude,
      place.latitude,
      place.longitude
    )
    return this.formatDistance(meters)
  }

  openManagePlaces() {
    this.placeDialogView = 'manage'
    this.savedPlacesSearch = ''
  }

  openAddSavedPlace(seedType: SavedPlaceType = 'other') {
    this.placeDialogView = 'add'
    this.resetLocationState()
    this.locationTrigger = 'arrive'
    this.addPlaceType = seedType
    this.addPlaceName = seedType === 'other' ? '' : this.titleCase(seedType)
    this.addPlaceRadiusMeters = 100
  }

  openSearchPlace(keepPhrase = false) {
    const phrase = this.locationPhrase
    this.placeDialogView = 'search'
    this.resetLocationState()
    if (keepPhrase) this.locationPhrase = phrase
    this.locationTrigger = 'arrive'
  }

  async resolveLocation(view: PlaceDialogView = this.placeDialogView) {
    const phrase = this.locationPhrase.trim()
    if (!phrase) return
    this.resolving = true
    this.locationState = 'idle'
    try {
      await this.loadCurrentLocation()
      const result = await this.keptPlugins.resolveLocation(phrase, this.savedPlaces, this.currentLocation)
      if (!result) {
        this.permissionReason = 'Location search is not available in this version of the app.'
        this.locationState = 'permission'
        return
      }
      switch (result.status) {
        case 'resolved':
          this.resolvedLocation = result.location
          this.locationPhrase = result.location.displayName
          this.locationState = 'resolved'
          if (view === 'add' && !this.addPlaceName.trim()) {
            this.addPlaceName = this.suggestPlaceName(result.location.displayName)
          }
          this.hydrateLocationMapPreview(result.location)
          break
        case 'ambiguous':
          this.candidates = result.candidates
          this.locationState = 'ambiguous'
          break
        case 'notFound':
          this.locationState = 'notFound'
          break
        case 'needsLocationPermission':
          this.permissionReason = result.reason
          this.locationState = 'permission'
          break
      }
    } finally {
      this.resolving = false
    }
  }

  selectCandidate(candidate: ResolvedLocation) {
    this.resolvedLocation = candidate
    this.locationPhrase = candidate.displayName
    this.locationState = 'resolved'
    if (this.placeDialogView === 'add' && !this.addPlaceName.trim()) {
      this.addPlaceName = this.suggestPlaceName(candidate.displayName)
    }
    this.hydrateLocationMapPreview(candidate)
  }

  resetLocationState() {
    this.locationState = 'idle'
    this.locationPhrase = ''
    this.resolvedLocation = null
    this.locationMapPreview = ''
    this.candidates = []
    this.resolving = false
    this.permissionReason = ''
  }

  clearLocation() {
    this.resetLocationState()
    this.showReminderLocationDialog = false
  }

  async confirmSavedPlaceReminder(place: LocationSavedPlace) {
    await this.prepareLocationReminder({
      displayName: place.name || place.address || 'Saved place',
      latitude: place.latitude,
      longitude: place.longitude,
      radiusMeters: place.radiusMeters,
      confidence: 'high',
      source: 'savedLocation'
    }, place.locationTrigger)
  }

  choosePlaceItem(place: PlaceListItem) {
    if ('prompt' in place) {
      this.openAddSavedPlace(place.placeType)
      return
    }
    this.confirmSavedPlaceReminder(place)
  }

  async confirmLocationReminder(location = this.resolvedLocation, trigger = this.locationTrigger) {
    if (!location) return
    await this.prepareLocationReminder(location, trigger)
  }

  private async prepareLocationReminder(location: ResolvedLocation, trigger: LocationTrigger) {
    const permissionReady = await this.ensureLocationReminderPermissionsOrEducate(location, trigger)
    if (!permissionReady) return
    this.setPendingLocationReminder(location, trigger)
  }

  private async ensureLocationReminderPermissionsOrEducate(location: ResolvedLocation, trigger: LocationTrigger) {
    const status = await this.reminderService.getAndroidLocationPermissionStatus()
    if (!status) return true

    let locationStatus = status
    if (!locationStatus.foregroundGranted) {
      locationStatus = await this.reminderService.requestAndroidForegroundLocationPermission() || locationStatus
    }
    if (!locationStatus.foregroundGranted) {
      this.permissionReason = 'Location permission is needed to create location reminders.'
      this.locationState = 'permission'
      return false
    }

    if (!locationStatus.backgroundGranted) {
      this.pendingAndroidLocationReminder = { location, trigger }
      this.androidBackgroundLocationMessage = ''
      this.showAndroidBackgroundLocationEducation = true
      this.bindAndroidBackgroundLocationResume()
      this.cd.detectChanges()
      return false
    }

    const notificationsOk = await this.reminderService.ensureAndroidGeofenceNotificationPermission()
    if (!notificationsOk) {
      this.permissionReason = 'Notification permission is needed so Kept can show location reminder alerts.'
      this.locationState = 'permission'
      return false
    }
    return true
  }

  async openAndroidBackgroundLocationSettings() {
    this.androidBackgroundLocationMessage = ''
    await this.reminderService.openAndroidBackgroundLocationSettings()
  }

  cancelAndroidBackgroundLocationEducation() {
    this.showAndroidBackgroundLocationEducation = false
    this.androidBackgroundLocationMessage = ''
    this.pendingAndroidLocationReminder = null
    this.unbindAndroidBackgroundLocationResume()
  }

  private bindAndroidBackgroundLocationResume() {
    if (this.androidBackgroundLocationResumeHandler || typeof document === 'undefined') return
    this.androidBackgroundLocationResumeHandler = () => {
      if (document.visibilityState === 'visible') this.resumePendingAndroidLocationReminder()
    }
    this.androidBackgroundLocationFocusHandler = () => this.resumePendingAndroidLocationReminder()
    document.addEventListener('visibilitychange', this.androidBackgroundLocationResumeHandler)
    window.addEventListener('focus', this.androidBackgroundLocationFocusHandler)
  }

  private unbindAndroidBackgroundLocationResume() {
    if (this.androidBackgroundLocationResumeHandler) {
      document.removeEventListener('visibilitychange', this.androidBackgroundLocationResumeHandler)
      this.androidBackgroundLocationResumeHandler = undefined
    }
    if (this.androidBackgroundLocationFocusHandler) {
      window.removeEventListener('focus', this.androidBackgroundLocationFocusHandler)
      this.androidBackgroundLocationFocusHandler = undefined
    }
  }

  private async resumePendingAndroidLocationReminder() {
    const pending = this.pendingAndroidLocationReminder
    if (!pending || this.androidBackgroundLocationResumeRunning) return
    this.androidBackgroundLocationResumeRunning = true
    try {
      const status = await this.reminderService.getAndroidLocationPermissionStatus()
      if (!status?.backgroundGranted) {
        this.androidBackgroundLocationMessage = 'Permission still needed. Choose “Allow all the time” to enable this reminder.'
        this.showAndroidBackgroundLocationEducation = true
        this.cd.detectChanges()
        return
      }
      const notificationsOk = await this.reminderService.ensureAndroidGeofenceNotificationPermission()
      if (!notificationsOk) {
        this.androidBackgroundLocationMessage = 'Notification permission is needed so Kept can show this reminder.'
        this.showAndroidBackgroundLocationEducation = true
        this.cd.detectChanges()
        return
      }
      this.pendingAndroidLocationReminder = null
      this.showAndroidBackgroundLocationEducation = false
      this.androidBackgroundLocationMessage = ''
      this.unbindAndroidBackgroundLocationResume()
      this.setPendingLocationReminder(pending.location, pending.trigger)
    } finally {
      this.androidBackgroundLocationResumeRunning = false
    }
  }

  private setPendingLocationReminder(location: ResolvedLocation, trigger: LocationTrigger) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const pendingLocation = {
      locationName: location.displayName,
      latitude: location.latitude,
      longitude: location.longitude,
      radiusMeters: location.radiusMeters,
      locationTrigger: trigger,
      timezone: tz
    }

    this.pendingReminderDate = null
    this.pendingReminderLocation = pendingLocation
    this.clearLocation()
    this.showReminderLocationDialog = false
    this.cd.detectChanges()

    if (this.isEditing && this.noteToEdit.id) {
      const noteId = this.noteToEdit.id
      const title = this.notePlainText(this.noteTitle?.nativeElement?.innerHTML || this.noteToEdit.noteTitle || '')
      const body = this.notePlainText(this.noteBody?.nativeElement?.innerHTML || this.noteToEdit.noteBody || '')
      this.reminderService.create({
        noteId,
        locationName: pendingLocation.locationName,
        latitude: pendingLocation.latitude,
        longitude: pendingLocation.longitude,
        radiusMeters: pendingLocation.radiusMeters,
        locationTrigger: pendingLocation.locationTrigger,
        timezone: pendingLocation.timezone,
        title,
        body
      }).then(result => {
        if (result) {
          this.pendingReminderLocation = null
          this.cd.detectChanges()
        } else {
          this.showReminderSaveError()
        }
      }).catch(() => this.showReminderSaveError())
    }
  }

  async saveSavedPlace() {
    const location = this.resolvedLocation
    if (!location || !this.addPlaceName.trim() || this.addPlaceSaving) return
    this.addPlaceSaving = true
    try {
      await this.savedPlacesService.create({
        name: this.addPlaceName.trim(),
        address: location.displayName,
        placeType: this.addPlaceType,
        latitude: location.latitude,
        longitude: location.longitude,
        radiusMeters: this.addPlaceRadiusMeters,
        locationTrigger: this.locationTrigger,
        mapPreviewUrl: this.locationMapPreview || null
      })
      await this.loadSavedPlaces()
      this.placeDialogView = 'choose'
      this.resetLocationState()
    } catch {
      this.savedPlacesError = 'Saved place could not be saved.'
    } finally {
      this.addPlaceSaving = false
      this.cd.detectChanges()
    }
  }

  placeSwipeStart(event: PointerEvent, place: LocationSavedPlace) {
    this.placeSwipeStartPoint = { id: place.id, x: event.clientX, y: event.clientY }
  }

  placeSwipeMove(event: PointerEvent, place: LocationSavedPlace) {
    if (!this.placeSwipeStartPoint || this.placeSwipeStartPoint.id !== place.id) return
    const dx = event.clientX - this.placeSwipeStartPoint.x
    const dy = event.clientY - this.placeSwipeStartPoint.y
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      this.swipingPlaceId = place.id
    }
  }

  async placeSwipeEnd(place: LocationSavedPlace) {
    if (!this.placeSwipeStartPoint || this.placeSwipeStartPoint.id !== place.id) return
    this.placeSwipeStartPoint = undefined
    if (this.swipingPlaceId !== place.id) this.swipingPlaceId = null
  }

  async deleteSavedPlace(place: LocationSavedPlace) {
    this.swipingPlaceId = null
    this.savedPlaces = this.savedPlaces.filter(item => item.id !== place.id)
    this.cd.detectChanges()
    try {
      await this.savedPlacesService.delete(place.id)
    } catch {
      this.savedPlacesError = 'Saved place could not be deleted.'
      await this.loadSavedPlaces()
    }
  }

  toggleLocationTrigger() {
    this.locationTrigger = this.locationTrigger === 'arrive' ? 'leave' : 'arrive'
  }

  setAddPlaceType(type: SavedPlaceType) {
    this.addPlaceType = type
    if (!this.addPlaceName.trim() && type !== 'other') {
      this.addPlaceName = this.titleCase(type)
    }
  }

  private suggestPlaceName(displayName: string) {
    return displayName.split(/[,\u2022]/)[0]?.trim().slice(0, 80) || ''
  }

  private titleCase(value: string) {
    return value.charAt(0).toUpperCase() + value.slice(1)
  }

  private loadCurrentLocation() {
    if (this.currentLocation || typeof navigator === 'undefined' || !navigator.geolocation) {
      return Promise.resolve()
    }
    this.currentLocationLoading = true
    return new Promise<void>(resolve => {
      navigator.geolocation.getCurrentPosition(
        position => {
          this.currentLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
          }
          this.currentLocationLoading = false
          this.cd.detectChanges()
          resolve()
        },
        () => {
          this.currentLocationLoading = false
          this.cd.detectChanges()
          resolve()
        },
        { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 4000 }
      )
    })
  }

  private distanceMeters(fromLat: number, fromLng: number, toLat: number, toLng: number) {
    const toRad = (value: number) => value * Math.PI / 180
    const earthRadiusMeters = 6371000
    const dLat = toRad(toLat - fromLat)
    const dLng = toRad(toLng - fromLng)
    const lat1 = toRad(fromLat)
    const lat2 = toRad(toLat)
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }

  private formatDistance(meters: number) {
    if (meters < 1000) return `${Math.max(1, Math.round(meters))} m`
    const km = meters / 1000
    return `${km < 10 ? Number(km.toFixed(1)) : Math.round(km)} km`
  }

  private async hydrateLocationMapPreview(location: ResolvedLocation) {
    try {
      this.locationMapPreview = await this.keptPlugins.locationMapPreview(location) || ''
    } catch {
      this.locationMapPreview = ''
    } finally {
      this.cd.detectChanges()
    }
  }

  private showReminderSaveError() {
    try {
      Snackbar.show({ pos: 'bottom-left', text: "Reminder couldn't be saved", duration: 3500 })
    } catch {}
  }
}
