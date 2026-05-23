import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { TimepickerUI, type ConfirmEventData } from 'timepicker-ui';
import { KeptAction, KeptActionPlan, KeptPlanExecution, KeptPlanValidation } from 'src/app/interfaces/ai';
import { AiService } from 'src/app/services/ai.service';
import { ReminderService } from 'src/app/services/reminder.service';
import { SharedService } from 'src/app/services/shared.service';
import { NotesService } from 'src/app/services/notes.service';
@Component({
    selector: 'app-main',
    templateUrl: './main.component.html',
    styleUrls: ['./main.component.scss'],
    standalone: false
})

export class MainComponent implements OnInit, OnDestroy {

  installHelpOpen = false;
  smartCaptureOpen = false;
  smartCaptureListening = false;
  smartCaptureLoading = false;
  smartCaptureRunning = false;
  smartCaptureTranscript = '';
  smartCapturePlan: KeptActionPlan | null = null;
  smartCaptureValidation: KeptPlanValidation | null = null;
  smartCaptureResult: KeptPlanExecution | null = null;
  smartCaptureError = '';
  selectedSmartActions = new Set<number>();
  smartReminderActionIndex: number | null = null;
  smartReminderDate = '';
  smartReminderTime = '';
  readonly calendarWeekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  calendarMonth = this.startOfMonth(new Date());
  private smartReminderTimePicker?: TimepickerUI;
  private smartReminderTimePickerInput?: HTMLInputElement;
  private smartCaptureEventHandler = (event: Event) => this.handleSmartCaptureEvent(event as CustomEvent);
  private readonly smartProposalColors = ['#e8f0fe', '#e6f4ea', '#f3e8fd', '#fef7e0', '#fce8e6', '#e4f7fb'];

  constructor(
    public Shared: SharedService,
    private ai: AiService,
    private notes: NotesService,
    private reminders: ReminderService,
    private ngZone: NgZone
  ) { }

  openMobileComposer() {
    this.Shared.openMobileComposer.next(true)
  }

  async startSmartCapture() {
    this.smartCaptureError = '';
    this.smartCaptureOpen = true;
    this.smartCaptureListening = true;
    this.smartCapturePlan = null;
    this.smartCaptureValidation = null;
    this.smartCaptureResult = null;
    this.selectedSmartActions.clear();
    this.closeSmartReminderPicker();
    const bridge = (window as any).KeptSmartCapture;
    if (bridge?.presentSmartCaptureModal) {
      await bridge.presentSmartCaptureModal();
      return;
    }
    if (bridge?.startSmartCapture) {
      await bridge.startSmartCapture();
      return;
    }
    const webkitHandler = (window as any).webkit?.messageHandlers?.keptSmartCapture;
    if (webkitHandler?.postMessage) {
      webkitHandler.postMessage({ type: 'presentSmartCaptureModal' });
      return;
    }
    this.smartCaptureError = 'Smart Capture is waiting for the iOS voice capture bridge.';
  }

  installPwa() {
    // If the browser fired beforeinstallprompt (Android Chrome / desktop
    // PWA-capable), invoke it directly; otherwise show iOS-style "Add to
    // Home Screen" walkthrough.
    if (this.Shared.deferredInstallPrompt) {
      const promptEvent = this.Shared.deferredInstallPrompt
      this.Shared.deferredInstallPrompt = undefined
      promptEvent.prompt()
      promptEvent.userChoice.finally(() => this.Shared.updateInstallVisibility())
      return
    }
    this.installHelpOpen = true
  }

  dismissInstallFab(event: Event) {
    event.stopPropagation()
    this.Shared.dismissInstallFab()
  }

  ngOnInit(): void {
    window.addEventListener('kept-smart-capture-plan', this.smartCaptureEventHandler as EventListener);
    window.addEventListener('smartCaptureCompleted', this.smartCaptureEventHandler as EventListener);
    (window as any).KeptSmartCapture = {
      ...((window as any).KeptSmartCapture || {}),
      receivePlan: (payload: any) => this.ngZone.run(() => this.receiveSmartCapture(payload))
    };
  }

  ngOnDestroy(): void {
    window.removeEventListener('kept-smart-capture-plan', this.smartCaptureEventHandler as EventListener);
    window.removeEventListener('smartCaptureCompleted', this.smartCaptureEventHandler as EventListener);
  }

  private handleSmartCaptureEvent(event: CustomEvent) {
    this.ngZone.run(() => this.receiveSmartCapture(event.detail || (event as any).data || {}));
  }

  async receiveSmartCapture(payload: { transcript?: string; actionPlan?: KeptActionPlan; plan?: KeptActionPlan }) {
    const actionPlan = payload.actionPlan || payload.plan;
    if (!actionPlan) {
      if (payload.transcript) this.smartCaptureTranscript = payload.transcript;
      return;
    }
    this.smartCaptureTranscript = payload.transcript || '';
    this.smartCapturePlan = actionPlan;
    this.smartCaptureResult = null;
    this.smartCaptureError = '';
    this.smartCaptureValidation = null;
    this.smartCaptureOpen = true;
    this.smartCaptureListening = false;
    this.closeSmartReminderPicker();
    this.selectedSmartActions = new Set((actionPlan.actions || []).map((_action, index) => index));
    await this.validateSmartCapture();
  }

  async validateSmartCapture() {
    if (!this.smartCapturePlan) return;
    const selectedBefore = new Set(this.selectedSmartActions);
    this.smartCaptureLoading = true;
    this.smartCaptureError = '';
    try {
      this.smartCaptureValidation = await this.ai.validatePlan(this.smartCaptureTranscript, this.smartCapturePlan);
      this.smartCapturePlan = this.smartCaptureValidation.normalizedPlan;
      this.selectedSmartActions = new Set((this.smartCapturePlan.actions || [])
        .map((_action, index) => index)
        .filter(index => selectedBefore.has(index)));
    } catch (error: any) {
      this.smartCaptureError = error?.error?.error || error?.error?.errors?.join(' ') || 'Could not validate Smart Capture plan.';
    } finally {
      this.smartCaptureLoading = false;
    }
  }

  toggleSmartAction(index: number, checked: boolean) {
    if (checked) this.selectedSmartActions.add(index);
    else this.selectedSmartActions.delete(index);
  }

  async runSmartCapture(selectedOnly = false) {
    if (!this.smartCapturePlan || !this.smartCaptureValidation?.valid) return;
    const selectedActionIndexes = selectedOnly ? Array.from(this.selectedSmartActions).sort((a, b) => a - b) : undefined;
    const preparedPlan = this.prepareSmartCapturePlan(selectedActionIndexes);
    if (!preparedPlan) return;
    this.smartCaptureRunning = true;
    this.smartCaptureError = '';
    this.smartCaptureResult = null;
    try {
      this.smartCaptureResult = await this.ai.executePlan(this.smartCaptureTranscript, preparedPlan, {
        confirmed: true,
        selectedActionIndexes
      });
      await this.notes.load();
      await this.reminders.load();
      setTimeout(() => this.closeSmartCapture(), 1200);
    } catch (error: any) {
      const errors = error?.error?.errors || error?.error?.failed?.map((f: any) => f.error);
      this.smartCaptureError = Array.isArray(errors) ? errors.join(' ') : (error?.error?.error || 'Could not run Smart Capture plan.');
    } finally {
      this.smartCaptureRunning = false;
    }
  }

  private prepareSmartCapturePlan(selectedActionIndexes?: number[]) {
    if (!this.smartCapturePlan) return null;
    const selected = selectedActionIndexes ? new Set(selectedActionIndexes) : null;
    const plan: KeptActionPlan = {
      ...this.smartCapturePlan,
      actions: this.smartCapturePlan.actions.map(action => ({ ...action }))
    };

    for (let index = 0; index < plan.actions.length; index++) {
      if (selected && !selected.has(index)) continue;
      const action = plan.actions[index] as any;
      if (action.type !== 'set_reminder' || action.dueAtUtc) continue;
      this.smartCaptureError = 'Pick a reminder date and time before running Smart Capture.';
      this.openSmartReminderPicker(index);
      return null;
    }

    this.smartCapturePlan = plan;
    return plan;
  }

  closeSmartCapture() {
    this.smartCaptureOpen = false;
    this.smartCaptureListening = false;
    this.smartCaptureLoading = false;
    this.smartCaptureRunning = false;
    this.smartCapturePlan = null;
    this.smartCaptureValidation = null;
    this.smartCaptureResult = null;
    this.smartCaptureError = '';
    this.selectedSmartActions.clear();
    this.closeSmartReminderPicker();
  }

  openSmartReminderPicker(index: number, event?: Event) {
    event?.stopPropagation();
    const action = this.smartCapturePlan?.actions?.[index] as any;
    const existing = action?.dueAtUtc ? new Date(action.dueAtUtc) : null;
    const baseDate = existing && !Number.isNaN(existing.getTime()) ? existing : new Date();
    this.smartReminderActionIndex = index;
    this.smartReminderDate = existing && !Number.isNaN(existing.getTime()) ? this.formatLocalDateInput(existing) : '';
    this.smartReminderTime = existing && !Number.isNaN(existing.getTime()) ? this.formatTimeInput(existing) : '';
    this.calendarMonth = this.startOfMonth(baseDate);
    this.destroySmartReminderTimePicker();
  }

  closeSmartReminderPicker() {
    this.smartReminderActionIndex = null;
    this.smartReminderDate = '';
    this.smartReminderTime = '';
    this.destroySmartReminderTimePicker();
  }

  confirmSmartReminderDate(timeInput: HTMLInputElement) {
    if (!this.smartReminderDate) return;
    this.createSmartReminderTimePicker(timeInput);
    this.smartReminderTimePicker?.open();
  }

  cancelSmartReminderDate() {
    this.closeSmartReminderPicker();
  }

  calendarMonthLabel() {
    return this.calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  calendarDays() {
    const month = this.calendarMonth.getMonth();
    const year = this.calendarMonth.getFullYear();
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const today = this.todayDateInput();
    const selected = this.smartReminderDate;

    return Array.from({ length: 42 }, (_value, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const iso = this.formatLocalDateInput(date);
      return {
        date: iso,
        day: date.getDate(),
        currentMonth: date.getMonth() === month,
        disabled: iso < today,
        selected: iso === selected,
        today: iso === today
      };
    });
  }

  shiftCalendarMonth(delta: number) {
    const next = new Date(this.calendarMonth);
    next.setMonth(next.getMonth() + delta);
    this.calendarMonth = this.startOfMonth(next);
  }

  selectCalendarDate(date: string) {
    if (date < this.todayDateInput()) return;
    this.smartReminderDate = date;
  }

  private async applySmartReminderTime(timeInput: HTMLInputElement) {
    if (this.smartReminderActionIndex === null || !this.smartCapturePlan) return;
    const time = this.toTwentyFourHourTime(this.smartReminderTime || timeInput.value);
    if (!this.smartReminderDate || !time) return;
    const dueAt = new Date(`${this.smartReminderDate}T${time}`);
    if (Number.isNaN(dueAt.getTime())) return;

    const actions = this.smartCapturePlan.actions.map((action, index) => {
      if (index !== this.smartReminderActionIndex) return { ...action };
      return {
        ...(action as any),
        dueAtUtc: dueAt.toISOString(),
        timezone: (action as any).timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      };
    });
    this.smartCapturePlan = { ...this.smartCapturePlan, actions };
    this.closeSmartReminderPicker();
    await this.validateSmartCapture();
  }

  private createSmartReminderTimePicker(timeInput: HTMLInputElement) {
    if (this.smartReminderTimePicker && this.smartReminderTimePickerInput === timeInput) return;
    this.destroySmartReminderTimePicker();
    this.smartReminderTimePickerInput = timeInput;
    timeInput.value = this.smartReminderTime || this.currentTimeValue();
    this.smartReminderTimePicker = new TimepickerUI(timeInput, {
      clock: { currentTime: { time: new Date(), updateInput: true } },
      ui: { editable: true },
      callbacks: {
        onConfirm: (data: ConfirmEventData) => {
          this.ngZone.run(() => {
            const hour = String(data.hour || '').padStart(2, '0');
            const minutes = String(data.minutes || '').padStart(2, '0');
            const period = data.type ? ` ${data.type}` : '';
            this.smartReminderTime = `${hour}:${minutes}${period}`;
            setTimeout(() => this.applySmartReminderTime(timeInput), 0);
          });
        }
      }
    });
    this.smartReminderTimePicker.create();
  }

  private destroySmartReminderTimePicker() {
    this.smartReminderTimePicker?.destroy({ keepInputValue: true });
    this.smartReminderTimePicker = undefined;
    this.smartReminderTimePickerInput = undefined;
  }

  private todayDateInput() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return this.formatLocalDateInput(date);
  }

  private formatLocalDateInput(date: Date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private formatTimeInput(date: Date) {
    let hour = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const period = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return `${String(hour).padStart(2, '0')}:${minutes} ${period}`;
  }

  private currentTimeValue() {
    return this.formatTimeInput(new Date());
  }

  private startOfMonth(date: Date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  private toTwentyFourHourTime(value: string) {
    if (!value) return '';
    const time = value.trim().toUpperCase().replace(/\./g, '');
    const twelveHour = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (twelveHour) {
      let hour = Number(twelveHour[1]);
      if (twelveHour[3] === 'PM' && hour < 12) hour += 12;
      if (twelveHour[3] === 'AM' && hour === 12) hour = 0;
      return `${String(hour).padStart(2, '0')}:${twelveHour[2]}`;
    }
    const twentyFourHour = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!twentyFourHour) return '';
    const hour = Number(twentyFourHour[1]);
    const minutes = Number(twentyFourHour[2]);
    if (hour > 23 || minutes > 59) return '';
    return `${String(hour).padStart(2, '0')}:${twentyFourHour[2]}`;
  }

  actionTitle(action: KeptAction) {
    return action.type.replace(/_/g, ' ');
  }

  actionSummary(action: KeptAction) {
    const anyAction = action as any;
    if (action.type === 'create_text_note') return anyAction.title || anyAction.text || 'Create a text note';
    if (action.type === 'create_todo_note') return `${anyAction.title || 'New checklist'} · ${(anyAction.items || []).length} items`;
    if (action.type === 'append_to_note') return anyAction.text || 'Append text';
    if (action.type === 'add_checklist_items') return `${(anyAction.items || []).length} checklist items`;
    if (action.type === 'add_labels') return (anyAction.labels || []).join(', ');
    if (action.type === 'set_reminder') return anyAction.dueAtUtc ? new Date(anyAction.dueAtUtc).toLocaleString() : 'Reminder time needed';
    if (action.type === 'share_note') return `${(anyAction.userIds || []).length} collaborator(s)`;
    return 'Smart action';
  }

  actionMeta(action: KeptAction) {
    const noteId = (action as any).noteId;
    return noteId ? `Note #${noteId}` : '';
  }

  proposalColor(action: KeptAction, index: number) {
    const anyAction = action as any;
    if (anyAction.bgColor) return anyAction.bgColor;
    return this.smartProposalColors[index % this.smartProposalColors.length];
  }

  proposalBadge(action: KeptAction) {
    if (action.type === 'create_text_note' || action.type === 'create_todo_note') return 'New';
    if (action.type === 'append_to_note' || action.type === 'add_checklist_items' || action.type === 'add_labels') return 'Updates';
    if (action.type === 'set_reminder') return 'Reminder';
    if (action.type === 'share_note') return 'Share';
    if (action.type === 'archive_note') return 'Archive';
    if (action.type === 'trash_note') return 'Trash';
    return 'Action';
  }

  proposalTitle(action: KeptAction) {
    const anyAction = action as any;
    if (action.type === 'create_text_note' || action.type === 'create_todo_note') return anyAction.title || 'Untitled note';
    if (action.type === 'append_to_note') return 'Append to note';
    if (action.type === 'add_checklist_items') return 'Add checklist items';
    if (action.type === 'add_labels') return 'Add labels';
    if (action.type === 'set_reminder') return 'Set reminder';
    if (action.type === 'share_note') return 'Share note';
    if (action.type === 'archive_note') return 'Archive note';
    if (action.type === 'trash_note') return 'Move note to trash';
    return this.actionTitle(action);
  }

  proposalBody(action: KeptAction) {
    const anyAction = action as any;
    if (action.type === 'create_text_note') return anyAction.text || anyAction.body || '';
    if (action.type === 'append_to_note') return anyAction.text || '';
    if (action.type === 'add_labels') return (anyAction.labels || []).join(', ');
    if (action.type === 'set_reminder') return anyAction.dueAtUtc ? new Date(anyAction.dueAtUtc).toLocaleString() : 'Reminder time needed';
    if (action.type === 'share_note') return `${(anyAction.userIds || []).length} collaborator(s)`;
    if (action.type === 'archive_note') return 'This note will move out of the main notes view.';
    if (action.type === 'trash_note') return 'This note will move to trash.';
    return '';
  }

  proposalChecklistItems(action: KeptAction) {
    const anyAction = action as any;
    if (action.type !== 'create_todo_note' && action.type !== 'add_checklist_items') return [];
    return (anyAction.items || []).map((item: any) => typeof item === 'string' ? item : (item?.data || item?.text || item?.title || '')).filter(Boolean);
  }

  proposalExtra(action: KeptAction) {
    const anyAction = action as any;
    if (action.type === 'add_labels') return `${(anyAction.labels || []).length} label(s)`;
    if (action.type === 'set_reminder' && anyAction.timezone) return anyAction.timezone;
    if (action.type === 'share_note') return 'Shared note';
    return this.actionMeta(action);
  }

}
