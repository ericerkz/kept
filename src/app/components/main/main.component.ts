import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { TimepickerUI, type ConfirmEventData } from 'timepicker-ui';
import { KeptAction, KeptActionPlan, KeptPlanExecution, KeptPlanValidation } from 'src/app/interfaces/ai';
import { AiService } from 'src/app/services/ai.service';
import { ReminderService } from 'src/app/services/reminder.service';
import { SharedService } from 'src/app/services/shared.service';
import { NotesService } from 'src/app/services/notes.service';
import { ShareUserI } from 'src/app/interfaces/users';

interface SmartCaptureEstimateAction {
  type: string;
  intent?: string;
  confidence?: number;
}

interface SmartCaptureEstimate {
  transcript?: string;
  status?: 'listening' | 'transcribing' | 'planning';
  estimatedActions?: SmartCaptureEstimateAction[];
}

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
  smartVoiceCapturing = false;
  smartCaptureAvailable = false;
  smartCaptureTranscript = '';
  smartCaptureEstimate: SmartCaptureEstimate | null = null;
  smartCapturePlan: KeptActionPlan | null = null;
  smartCaptureValidation: KeptPlanValidation | null = null;
  smartCaptureResult: KeptPlanExecution | null = null;
  smartCaptureError = '';
  smartShareUsers: ShareUserI[] = [];
  selectedSmartActions = new Set<number>();
  smartReminderActionIndex: number | null = null;
  smartReminderDate = '';
  smartReminderTime = '';
  readonly calendarWeekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  calendarMonth = this.startOfMonth(new Date());
  private smartReminderTimePicker?: TimepickerUI;
  private smartReminderTimePickerInput?: HTMLInputElement;
  private smartVoiceTranscriptListener?: { remove: () => Promise<void> | void };
  private smartCaptureEventHandler = (event: Event) => this.handleSmartCaptureEvent(event as CustomEvent);
  private smartCaptureEstimateEventHandler = (event: Event) => this.handleSmartCaptureEstimateEvent(event as CustomEvent);
  readonly smartProposalColors = ['#e8f0fe', '#e6f4ea', '#f3e8fd', '#fef7e0', '#fce8e6', '#e4f7fb'];

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
    if (!this.smartCaptureAvailable) {
      await this.refreshSmartCaptureAvailability();
      if (!this.smartCaptureAvailable) return;
    }
    this.openSmartCaptureListening();
    await this.beginSmartCaptureListening();
  }

  private openSmartCaptureListening() {
    this.setSmartCaptureDocumentLock(true);
    this.smartCaptureError = '';
    this.smartCaptureOpen = true;
    this.smartCaptureListening = true;
    this.smartCaptureTranscript = '';
    this.smartCaptureEstimate = null;
    this.smartCapturePlan = null;
    this.smartCaptureValidation = null;
    this.smartCaptureResult = null;
    this.selectedSmartActions.clear();
    this.smartShareUsers = [];
    this.closeSmartReminderPicker();
  }

  async beginSmartCaptureListening() {
    this.openSmartCaptureListening();
    const plugin = this.keptIntelligencePlugin();
    if (!plugin?.startVoiceCapture) {
      this.smartCaptureError = 'Smart Capture is waiting for the iOS voice capture plugin.';
      return;
    }

    try {
      await this.bindVoiceTranscriptListener(plugin);
      await plugin.startVoiceCapture();
      this.smartVoiceCapturing = true;
    } catch (error: any) {
      this.smartVoiceCapturing = false;
      this.smartCaptureListening = false;
      this.smartCaptureError = error?.message || 'Could not start Smart Capture voice input.';
    }
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
    this.refreshSmartCaptureAvailability();
    window.addEventListener('kept-smart-capture-estimate', this.smartCaptureEstimateEventHandler as EventListener);
    window.addEventListener('kept-smart-capture-plan', this.smartCaptureEventHandler as EventListener);
    window.addEventListener('smartCaptureCompleted', this.smartCaptureEventHandler as EventListener);
    (window as any).KeptSmartCapture = {
      ...((window as any).KeptSmartCapture || {}),
      receiveEstimate: (payload: SmartCaptureEstimate) => this.ngZone.run(() => this.receiveSmartCaptureEstimate(payload)),
      receivePlan: (payload: any) => this.ngZone.run(() => this.receiveSmartCapture(payload))
    };
  }

  ngOnDestroy(): void {
    window.removeEventListener('kept-smart-capture-estimate', this.smartCaptureEstimateEventHandler as EventListener);
    window.removeEventListener('kept-smart-capture-plan', this.smartCaptureEventHandler as EventListener);
    window.removeEventListener('smartCaptureCompleted', this.smartCaptureEventHandler as EventListener);
    this.removeVoiceTranscriptListener();
    this.setSmartCaptureDocumentLock(false);
  }

  private handleSmartCaptureEstimateEvent(event: CustomEvent) {
    this.ngZone.run(() => this.receiveSmartCaptureEstimate(event.detail || (event as any).data || {}));
  }

  private handleSmartCaptureEvent(event: CustomEvent) {
    this.ngZone.run(() => this.receiveSmartCapture(event.detail || (event as any).data || {}));
  }

  receiveSmartCaptureEstimate(payload: SmartCaptureEstimate) {
    if (!payload?.estimatedActions?.length) return;
    if (payload.transcript) this.smartCaptureTranscript = payload.transcript;
    this.smartCaptureEstimate = payload;
    this.setSmartCaptureDocumentLock(true);
    this.smartCaptureOpen = true;
    this.smartCaptureListening = payload.status === 'listening';
    this.smartCaptureError = '';
  }

  async receiveSmartCapture(payload: { transcript?: string; actionPlan?: KeptActionPlan; plan?: KeptActionPlan }) {
    const actionPlan = payload.actionPlan || payload.plan;
    if (!actionPlan) {
      if (payload.transcript) this.smartCaptureTranscript = payload.transcript;
      return;
    }
    this.smartCaptureTranscript = payload.transcript || '';
    this.smartCapturePlan = actionPlan;
    this.setSmartCaptureDocumentLock(true);
    this.smartCaptureEstimate = null;
    this.smartCaptureResult = null;
    this.smartCaptureError = '';
    this.smartCaptureValidation = null;
    this.smartCaptureOpen = true;
    this.smartCaptureListening = false;
    this.closeSmartReminderPicker();
    this.selectedSmartActions = new Set((actionPlan.actions || []).map((_action, index) => index));
    this.loadSmartShareUsers();
    await this.validateSmartCapture();
  }

  async validateSmartCapture() {
    if (!this.smartCapturePlan) return;
    const selectedBefore = new Set(this.selectedSmartActions);
    const previousActionCount = this.smartCapturePlan.actions?.length || 0;
    this.smartCaptureLoading = true;
    this.smartCaptureError = '';
    try {
      this.smartCaptureValidation = await this.ai.validatePlan(this.smartCaptureTranscript, this.smartCapturePlan);
      this.smartCapturePlan = this.smartCaptureValidation.normalizedPlan;
      const nextIndexes = (this.smartCapturePlan.actions || []).map((_action, index) => index);
      this.selectedSmartActions = previousActionCount === nextIndexes.length
        ? new Set(nextIndexes.filter(index => selectedBefore.has(index)))
        : new Set(nextIndexes);
      this.selectReminderActions();
    } catch (error: any) {
      this.smartCaptureError = error?.error?.error || error?.error?.errors?.join(' ') || 'Could not validate Smart Capture plan.';
    } finally {
      this.smartCaptureLoading = false;
    }
  }

  toggleSmartAction(index: number, checked: boolean) {
    const indexes = checked
      ? [index, ...this.connectedShareActionIndexes(index), ...this.prerequisiteActionIndexes(index)]
      : [index, ...this.connectedShareActionIndexes(index), ...this.dependentActionIndexes(index)];
    for (const actionIndex of indexes) {
      if (checked) this.selectedSmartActions.add(actionIndex);
      else this.selectedSmartActions.delete(actionIndex);
    }
  }

  private selectReminderActions() {
    for (const [index, action] of (this.smartCapturePlan?.actions || []).entries()) {
      if (this.isReminderAction(action)) this.selectedSmartActions.add(index);
    }
  }

  isSmartActionSelected(index: number) {
    const action = this.smartCapturePlan?.actions?.[index];
    return this.selectedSmartActions.has(index) || this.isReminderAction(action);
  }

  selectedActionIndexes() {
    return (this.smartCapturePlan?.actions || [])
      .map((_action, index) => index)
      .filter(index => this.isSmartActionSelected(index));
  }

  private isReminderAction(action: any) {
    return action?.type === 'set_reminder'
      || action?.type === 'reminder'
      || action?.intent === 'reminder';
  }

  async runSmartCapture(selectedOnly = false) {
    if (!this.smartCapturePlan || !this.smartCaptureValidation?.valid) return;
    const selectedActionIndexes = selectedOnly ? this.selectedActionIndexes() : undefined;
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
      const confirmedActions = selectedActionIndexes
        ? preparedPlan.actions.filter((_action, index) => selectedActionIndexes.includes(index))
        : preparedPlan.actions;
      await this.syncNativeConfirmedReminders(confirmedActions);
      await this.notes.ensureNotesVisible(this.smartCaptureResult.createdNoteIds || []);
      await this.notes.load(undefined, { cacheBust: true });
      await this.reminders.load();
      this.closeSmartCapture();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('kept-smart-capture-notes-added'));
        window.dispatchEvent(new Event('resize'));
      }));
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
      if ((action.type === 'create_text_note' || action.type === 'create_todo_note') && !action.bgColor) {
        action.bgColor = this.proposalColor(action, index);
      }
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
    this.setSmartCaptureDocumentLock(false);
    this.smartCaptureListening = false;
    this.smartCaptureLoading = false;
    this.smartCaptureRunning = false;
    this.smartVoiceCapturing = false;
    this.smartCaptureEstimate = null;
    this.smartCapturePlan = null;
    this.smartCaptureValidation = null;
    this.smartCaptureResult = null;
    this.smartCaptureError = '';
    this.smartShareUsers = [];
    this.selectedSmartActions.clear();
    this.closeSmartReminderPicker();
  }

  async cancelSmartCapture() {
    await this.cancelNativeVoiceCapture();
    this.closeSmartCapture();
  }

  async toggleSmartVoiceCapture() {
    if (this.smartVoiceCapturing) {
      await this.stopNativeVoiceCapture();
      return;
    }
    await this.beginSmartCaptureListening();
  }

  async finishSmartCaptureVoice() {
    if (this.smartCaptureLoading) return;
    this.smartCaptureLoading = true;
    this.smartCaptureError = '';
    try {
      const command = await this.commandForSmartCapturePlanning();
      if (!command) {
        this.smartCaptureError = 'Say something first, then tap Done.';
        return;
      }
      const plugin = this.keptIntelligencePlugin();
      if (!plugin?.processTextCommand) {
        this.smartCaptureError = 'Smart Capture is waiting for the iOS planning plugin.';
        return;
      }
      const result = await plugin.processTextCommand({ command, context: {} });
      if (!result?.actionPlan) {
        this.smartCaptureError = 'Smart Capture did not return an action plan.';
        return;
      }
      await this.receiveSmartCapture({ transcript: command, actionPlan: result?.actionPlan });
    } catch (error: any) {
      this.smartCaptureError = error?.message || 'Could not prepare the Smart Capture proposal.';
    } finally {
      this.smartCaptureLoading = false;
    }
  }

  async smartPrimaryAction() {
    if (this.smartCapturePlan) {
      await this.runSmartCapture(true);
      return;
    }
    await this.finishSmartCaptureVoice();
  }

  smartPrimaryLabel() {
    if (!this.smartCapturePlan) return this.smartCaptureLoading || this.smartCaptureEstimate ? 'Planning…' : 'Done';
    return this.smartCaptureRunning ? 'Saving…' : 'Approve';
  }

  smartPrimaryDisabled() {
    if (!this.smartCapturePlan) return this.smartCaptureLoading || !!this.smartCaptureEstimate;
    return this.smartCaptureRunning || !this.selectedActionIndexes().length || !this.smartCaptureValidation?.valid;
  }

  smartVoiceIcon() {
    return this.smartVoiceCapturing ? 'stop' : 'mic';
  }

  private keptIntelligencePlugin() {
    return (window as any).Capacitor?.Plugins?.KeptIntelligence;
  }

  private async syncNativeConfirmedReminders(actions: KeptAction[]) {
    if (!actions.some(action => action.type === 'set_reminder')) return;

    const plugin = this.keptIntelligencePlugin();
    if (!plugin?.getCapabilities || !plugin?.syncConfirmedReminders) return;

    try {
      const capabilities = await plugin.getCapabilities();
      const foundationModels = capabilities?.foundationModels;
      const available = foundationModels?.isAvailable === true
        || foundationModels?.availability === 'available';
      if (!available) return;
      await plugin.syncConfirmedReminders({ actions });
    } catch (error) {
      console.warn('Could not sync Smart Capture reminders to Apple Reminders', error);
    }
  }

  private async refreshSmartCaptureAvailability() {
    if (!this.Shared.isIos) {
      this.smartCaptureAvailable = false;
      return;
    }

    const plugin = this.keptIntelligencePlugin();
    if (!plugin?.startVoiceCapture || !plugin?.processTextCommand) {
      this.smartCaptureAvailable = false;
      return;
    }

    if (!plugin?.getCapabilities) {
      this.smartCaptureAvailable = true;
      return;
    }

    try {
      const capabilities = await plugin.getCapabilities();
      const foundationModels = capabilities?.foundationModels;
      this.smartCaptureAvailable = foundationModels?.isAvailable === true
        || foundationModels?.availability === 'available';
    } catch {
      this.smartCaptureAvailable = false;
    }
  }

  private async bindVoiceTranscriptListener(plugin: any) {
    if (!plugin?.addListener || this.smartVoiceTranscriptListener) return;
    const listener = plugin.addListener('voiceTranscript', ({ text }: { text?: string; isFinal?: boolean }) => {
      this.ngZone.run(() => {
        if (text) this.smartCaptureTranscript = text;
      });
    });
    this.smartVoiceTranscriptListener = typeof listener?.then === 'function' ? await listener : listener;
  }

  private async removeVoiceTranscriptListener() {
    const listener = this.smartVoiceTranscriptListener;
    this.smartVoiceTranscriptListener = undefined;
    await listener?.remove?.();
  }

  private async stopNativeVoiceCapture() {
    const plugin = this.keptIntelligencePlugin();
    this.smartVoiceCapturing = false;
    this.smartCaptureListening = false;
    if (!plugin?.stopVoiceCapture) return this.smartCaptureTranscript;
    const result = await plugin.stopVoiceCapture();
    if (result?.text) this.smartCaptureTranscript = result.text;
    return result?.text || this.smartCaptureTranscript;
  }

  private async commandForSmartCapturePlanning() {
    const liveTranscript = (this.smartCaptureTranscript || '').trim();
    if (liveTranscript) {
      this.smartVoiceCapturing = false;
      this.smartCaptureListening = false;
      this.keptIntelligencePlugin()?.stopVoiceCapture?.()
        .then((result: any) => {
          if (result?.text) this.ngZone.run(() => { this.smartCaptureTranscript = result.text; });
        })
        .catch(console.error);
      return liveTranscript;
    }
    return (await this.stopNativeVoiceCapture() || '').trim();
  }

  private async cancelNativeVoiceCapture() {
    const plugin = this.keptIntelligencePlugin();
    this.smartVoiceCapturing = false;
    this.smartCaptureListening = false;
    if (plugin?.cancelVoiceCapture) await plugin.cancelVoiceCapture();
  }

  private setSmartCaptureDocumentLock(locked: boolean) {
    document.body.classList.toggle('kept-smart-capture-open', locked);
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

  proposalDisplayActions() {
    return (this.smartCapturePlan?.actions || [])
      .map((action, index) => ({ action, index }))
      .filter(item => !this.shouldHideShareAction(item.index));
  }

  private shouldHideShareAction(index: number) {
    const action = this.smartCapturePlan?.actions?.[index] as any;
    if (action?.type !== 'share_note') return false;
    return this.findConnectedProposalIndex(index) !== null;
  }

  private connectedShareActionIndexes(index: number) {
    const actions = this.smartCapturePlan?.actions || [];
    return actions
      .map((action, shareIndex) => ({ action: action as any, shareIndex }))
      .filter(item => item.action.type === 'share_note' && this.findConnectedProposalIndex(item.shareIndex) === index)
      .map(item => item.shareIndex);
  }

  private prerequisiteActionIndexes(index: number) {
    const actions = this.smartCapturePlan?.actions || [];
    const action = actions[index] as any;
    if (!action) return [];
    if (this.requiresPreviousCreatedNote(action)) {
      const dependencyIndex = this.previousCreateActionIndex(index);
      return dependencyIndex === null ? [] : [dependencyIndex];
    }
    return [];
  }

  private dependentActionIndexes(index: number) {
    const actions = this.smartCapturePlan?.actions || [];
    const action = actions[index] as any;
    if (action?.type !== 'create_text_note' && action?.type !== 'create_todo_note') return [];
    return actions
      .map((candidate, candidateIndex) => ({ candidate: candidate as any, candidateIndex }))
      .filter(item => item.candidateIndex > index && this.requiresPreviousCreatedNote(item.candidate)
        && this.previousCreateActionIndex(item.candidateIndex) === index)
      .map(item => item.candidateIndex);
  }

  private requiresPreviousCreatedNote(action: any) {
    return !this.numericNoteId(action?.noteId)
      && ['set_reminder', 'share_note', 'add_labels', 'append_to_note', 'add_checklist_items'].includes(action?.type);
  }

  private previousCreateActionIndex(beforeIndex: number) {
    const actions = this.smartCapturePlan?.actions || [];
    for (let index = beforeIndex - 1; index >= 0; index--) {
      const action = actions[index] as any;
      if (action?.type === 'create_text_note' || action?.type === 'create_todo_note') return index;
    }
    return null;
  }

  private findConnectedProposalIndex(shareIndex: number) {
    const actions = this.smartCapturePlan?.actions || [];
    const share = actions[shareIndex] as any;
    if (!share || share.type !== 'share_note') return null;
    const shareNoteId = this.numericNoteId(share.noteId);
    if (shareNoteId) {
      const targetIndex = actions.findIndex((action, index) =>
        index !== shareIndex && (action as any).type !== 'share_note' && this.numericNoteId((action as any).noteId) === shareNoteId
      );
      if (targetIndex >= 0) return targetIndex;
    }
    for (let index = shareIndex - 1; index >= 0; index--) {
      const action = actions[index] as any;
      if (this.isNoteProposalAction(action)) return index;
    }
    return null;
  }

  private isNoteProposalAction(action: any) {
    return action?.type === 'create_text_note'
      || action?.type === 'create_todo_note'
      || action?.type === 'append_to_note'
      || action?.type === 'add_checklist_items';
  }

  shareRecipientsForAction(index: number) {
    const userIds = this.connectedShareActionIndexes(index)
      .flatMap(shareIndex => this.actionUserIds(this.smartCapturePlan?.actions?.[shareIndex] as any));
    return [...new Set(userIds)]
      .map(userId => this.smartShareUsers.find(user => user.id === userId) || {
        id: userId,
        username: `User ${userId}`,
        displayName: `User ${userId}`,
        avatarDataUrl: '',
        avatarPreset: 'cat',
        shareCount: 0
      });
  }

  private loadSmartShareUsers() {
    const hasShareAction = !!this.smartCapturePlan?.actions?.some(action => action.type === 'share_note');
    if (!hasShareAction) return;
    this.notes.listShareUsers()
      .then(users => { this.smartShareUsers = users; })
      .catch(error => console.error('Could not load Smart Capture share users', error));
  }

  private numericNoteId(value: any) {
    const id = Number(value);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  private actionUserIds(action: any) {
    const raw = action?.userIds ?? action?.shareWithUserIds ?? action?.collaboratorUserIds ?? [];
    return (Array.isArray(raw) ? raw : [raw])
      .map(userId => Number(userId))
      .filter(userId => Number.isFinite(userId) && userId > 0);
  }

  estimateActions() {
    return this.smartCaptureEstimate?.estimatedActions?.length
      ? this.smartCaptureEstimate.estimatedActions
      : [{ type: 'create_text_note', intent: 'new', confidence: 0.6 }];
  }

  estimateBadge(action: SmartCaptureEstimateAction) {
    if (action.intent === 'new' || action.type === 'create_text_note' || action.type === 'create_todo_note') return 'New';
    if (action.intent === 'share' || action.type === 'share_note') return 'Share';
    if (action.intent === 'reminder' || action.type === 'set_reminder') return 'Reminder';
    if (action.intent === 'archive' || action.type === 'archive_note') return 'Archive';
    if (action.intent === 'trash' || action.type === 'trash_note') return 'Trash';
    return 'Updates';
  }

  estimateIcon(action: SmartCaptureEstimateAction) {
    if (action.type === 'create_todo_note') return 'checklist';
    if (action.type === 'share_note') return 'group';
    if (action.type === 'set_reminder') return 'notifications';
    if (action.type === 'archive_note') return 'archive';
    if (action.type === 'trash_note') return 'delete';
    if (action.type === 'add_labels') return 'label';
    return 'notes';
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
