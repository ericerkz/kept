import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
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
  smartCaptureLoading = false;
  smartCaptureRunning = false;
  smartCaptureTranscript = '';
  smartCapturePlan: KeptActionPlan | null = null;
  smartCaptureValidation: KeptPlanValidation | null = null;
  smartCaptureResult: KeptPlanExecution | null = null;
  smartCaptureError = '';
  selectedSmartActions = new Set<number>();
  private smartCaptureEventHandler = (event: Event) => this.handleSmartCaptureEvent(event as CustomEvent);

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
    this.smartCaptureOpen = true;
    this.smartCapturePlan = null;
    this.smartCaptureValidation = null;
    this.smartCaptureResult = null;
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
    if (!actionPlan) return;
    this.smartCaptureTranscript = payload.transcript || '';
    this.smartCapturePlan = actionPlan;
    this.smartCaptureResult = null;
    this.smartCaptureError = '';
    this.smartCaptureValidation = null;
    this.smartCaptureOpen = true;
    this.selectedSmartActions = new Set((actionPlan.actions || []).map((_action, index) => index));
    await this.validateSmartCapture();
  }

  async validateSmartCapture() {
    if (!this.smartCapturePlan) return;
    this.smartCaptureLoading = true;
    this.smartCaptureError = '';
    try {
      this.smartCaptureValidation = await this.ai.validatePlan(this.smartCaptureTranscript, this.smartCapturePlan);
      this.smartCapturePlan = this.smartCaptureValidation.normalizedPlan;
      this.selectedSmartActions = new Set((this.smartCapturePlan.actions || []).map((_action, index) => index));
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
      const answer = window.prompt('When should Kept remind you? Enter a date and time, like 2026-05-20 3:30 PM.');
      if (!answer) {
        this.smartCaptureError = 'Reminder time is required before Kept can create that reminder.';
        return null;
      }
      const dueAtUtc = this.parseReminderPrompt(answer);
      if (!dueAtUtc) {
        this.smartCaptureError = 'Could not understand that reminder time. Try YYYY-MM-DD HH:MM.';
        return null;
      }
      action.dueAtUtc = dueAtUtc;
      action.timezone = action.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }

    this.smartCapturePlan = plan;
    return plan;
  }

  private parseReminderPrompt(value: string) {
    const raw = value.trim();
    if (!raw) return '';
    const explicit = raw.match(/^(\d{4}-\d{2}-\d{2})[ T]+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (explicit) {
      let hour = Number(explicit[2]);
      const minute = Number(explicit[3] || 0);
      const meridiem = explicit[4]?.toUpperCase();
      if (meridiem === 'PM' && hour < 12) hour += 12;
      if (meridiem === 'AM' && hour === 12) hour = 0;
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        const [year, month, day] = explicit[1].split('-').map(Number);
        const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
        return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
      }
    }
    const normalized = raw
      .replace(/^today\b/i, new Date().toISOString().slice(0, 10))
      .replace(/^tomorrow\b/i, () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return d.toISOString().slice(0, 10);
      })
      .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/i, '$1T$2');
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }

  closeSmartCapture() {
    this.smartCaptureOpen = false;
    this.smartCaptureLoading = false;
    this.smartCaptureRunning = false;
    this.smartCapturePlan = null;
    this.smartCaptureValidation = null;
    this.smartCaptureResult = null;
    this.smartCaptureError = '';
    this.selectedSmartActions.clear();
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

}
