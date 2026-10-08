import { Injectable } from '@angular/core';
import {
  KeptAction,
  KeptActionPlan,
  KeptPlanExecution,
  KeptPlanValidation,
  SetReminderAction
} from '../interfaces/ai';
import { NoteI } from '../interfaces/notes';
import { NotesService } from './notes.service';
import { ReminderService } from './reminder.service';
import { LocalFirstVaultService } from '../kept2/local-first-vault.service';

const OFFLINE_ACTION_TYPES = new Set([
  'create_text_note',
  'create_todo_note',
  'append_to_note',
  'add_checklist_items',
  'add_labels',
  'share_note',
  'archive_note',
  'trash_note',
  'set_reminder'
]);

@Injectable({ providedIn: 'root' })
export class OfflineSmartCaptureService {
  constructor(
    private notes: NotesService,
    private reminders: ReminderService,
    private localVault: LocalFirstVaultService
  ) {}

  validate(transcript: string, inputPlan: KeptActionPlan): KeptPlanValidation {
    const normalizedPlan = this.normalizePlan(transcript, inputPlan);
    const errors: string[] = [];
    const warnings = ['Smart Capture will save these changes on this device and sync them when you reconnect.'];
    let createdNoteAvailable = false;

    if (!normalizedPlan.actions.length) errors.push('At least one action is required.');

    normalizedPlan.actions.forEach((action, index) => {
      const label = `actions[${index}]`;
      if (!OFFLINE_ACTION_TYPES.has(action.type)) {
        errors.push(`${label}.type requires an internet connection.`);
        return;
      }

      if (action.type === 'create_text_note' && !this.actionTitle(action) && !this.actionText(action)) {
        errors.push(`${label}.title or text is required.`);
      }
      if (action.type === 'create_todo_note' && !this.checklistItems(action).length) {
        errors.push(`${label}.items are required.`);
      }
      if (this.noteTargetRequired(action) && !action.noteId && !createdNoteAvailable) {
        errors.push(`${label}.noteId is required unless a previous action creates a note.`);
      }
      if (action.type === 'append_to_note' && !this.actionText(action)) {
        errors.push(`${label}.text is required.`);
      }
      if (action.type === 'add_checklist_items' && !this.checklistItems(action).length) {
        errors.push(`${label}.items are required.`);
      }
      if (action.type === 'add_labels' && !this.labelNames(action).length) {
        errors.push(`${label}.labels are required.`);
      }
      if (action.type === 'share_note' && !this.userIds(action).length) {
        errors.push(`${label}.userIds are required.`);
      }
      if (action.type === 'set_reminder') {
        const reminder = action as SetReminderAction;
        if (!reminder.noteId && !createdNoteAvailable) {
          errors.push(`${label}.noteId is required unless a previous action creates a note.`);
        }
        if (!reminder.dueAtUtc && !this.isLocationReminder(reminder)) {
          errors.push(`${label} needs a date and time or a saved location.`);
        }
        if (reminder.dueAtUtc) {
          const due = new Date(reminder.dueAtUtc);
          if (Number.isNaN(due.getTime())) errors.push(`${label}.dueAtUtc must be a valid date.`);
          else reminder.dueAtUtc = due.toISOString();
        }
        if (this.hasAnyLocationField(reminder) && !this.isLocationReminder(reminder)) {
          errors.push(`${label} has incomplete location details.`);
        }
        if (this.isLocationReminder(reminder)) {
          if (!Number.isFinite(Number(reminder.latitude))) errors.push(`${label}.latitude must be a valid number.`);
          if (!Number.isFinite(Number(reminder.longitude))) errors.push(`${label}.longitude must be a valid number.`);
          reminder.latitude = Number(reminder.latitude);
          reminder.longitude = Number(reminder.longitude);
          reminder.locationTrigger = reminder.locationTrigger === 'leave' ? 'leave' : 'arrive';
          reminder.radiusMeters = Number(reminder.radiusMeters ?? 120);
          if (!Number.isFinite(reminder.radiusMeters) || reminder.radiusMeters <= 0) {
            errors.push(`${label}.radiusMeters must be a positive number.`);
          }
        }
      }

      if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
        createdNoteAvailable = true;
      }
    });

    return {
      valid: errors.length === 0,
      ok: errors.length === 0,
      errors,
      warnings,
      normalizedPlan,
      requiresConfirmation: true
    };
  }

  async execute(plan: KeptActionPlan, selectedActionIndexes?: number[]): Promise<KeptPlanExecution> {
    const selected = selectedActionIndexes ? new Set(selectedActionIndexes) : null;
    const result: KeptPlanExecution = {
      ok: true,
      executed: [],
      failed: [],
      createdNoteIds: [],
      updatedNoteIds: [],
      createdLabelIds: [],
      reminderIds: []
    };
    let lastCreatedNote: NoteI | null = null;

    for (let index = 0; index < plan.actions.length; index += 1) {
      if (selected && !selected.has(index)) continue;
      const action = plan.actions[index];
      try {
        if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
          const note = this.noteFromAction(action);
          const noteId = await this.notes.add(note);
          if (noteId === -1) throw new Error('The note could not be saved offline.');
          lastCreatedNote = { ...note, id: noteId };
          result.createdNoteIds.push(noteId);
          result.executed.push({ type: action.type, noteId });
          continue;
        }

        if (action.type === 'append_to_note') {
          const noteId = this.resolveActionNoteId(action, lastCreatedNote);
          const note = await this.notes.get(noteId, { merge: false });
          const separator = note.noteBody && String(note.noteBody).trim() ? '<br>' : '';
          await this.notes.updateKey({
            noteBody: `${note.noteBody || ''}${separator}${this.escapeHtml(this.actionText(action))}`
          }, noteId);
          result.updatedNoteIds.push(noteId);
          result.executed.push({ type: action.type, noteId });
          continue;
        }

        if (action.type === 'add_checklist_items') {
          const noteId = this.resolveActionNoteId(action, lastCreatedNote);
          const note = await this.notes.get(noteId, { merge: false });
          const base = Date.now();
          const checkBoxes = [
            ...(note.checkBoxes || []),
            ...this.checklistItems(action).map((item, itemIndex) => ({
              id: base + itemIndex,
              data: item,
              done: false
            }))
          ];
          await this.notes.updateKey({ checkBoxes, isCbox: true }, noteId);
          result.updatedNoteIds.push(noteId);
          result.executed.push({ type: action.type, noteId });
          continue;
        }

        if (action.type === 'add_labels') {
          const noteId = this.resolveActionNoteId(action, lastCreatedNote);
          const note = await this.notes.get(noteId, { merge: false });
          const labels = await this.mergeLabels(note.labels || [], this.labelNames(action));
          await this.notes.updateKey({ labels }, noteId);
          result.updatedNoteIds.push(noteId);
          result.createdLabelIds.push(...labels.filter(label => label.id != null).map(label => label.id!));
          result.executed.push({ type: action.type, noteId, labels: labels.map(label => label.name) });
          continue;
        }

        if (action.type === 'set_reminder') {
          const reminderAction = action as SetReminderAction;
          const noteId = reminderAction.noteId || lastCreatedNote?.id;
          if (!noteId) throw new Error('The reminder does not have a note.');
          const reminder = await this.reminders.create({
            noteId,
            dueAtUtc: reminderAction.dueAtUtc,
            timezone: reminderAction.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            title: this.actionTitle(reminderAction) || lastCreatedNote?.noteTitle || 'Reminder',
            body: this.actionText(reminderAction) || lastCreatedNote?.noteBody || '',
            locationName: reminderAction.locationName,
            latitude: reminderAction.latitude,
            longitude: reminderAction.longitude,
            radiusMeters: reminderAction.radiusMeters ?? (reminderAction.locationName ? 120 : undefined),
            locationTrigger: reminderAction.locationTrigger
          });
          if (!reminder) throw new Error('The reminder could not be saved offline.');
          result.reminderIds.push(reminder.id);
          result.updatedNoteIds.push(noteId);
          result.executed.push({ type: action.type, reminderId: reminder.id, noteId });
          continue;
        }

        if (action.type === 'share_note') {
          const noteId = this.resolveActionNoteId(action, lastCreatedNote);
          const userIds = this.userIds(action);
          await this.notes.updateCollaborators(noteId, userIds);
          result.updatedNoteIds.push(noteId);
          result.executed.push({ type: action.type, noteId, userIds });
          continue;
        }

        if (action.type === 'archive_note') {
          const noteId = this.resolveActionNoteId(action, lastCreatedNote);
          await this.notes.updateKey({ archived: true, trashed: false }, noteId);
          result.updatedNoteIds.push(noteId);
          result.executed.push({ type: action.type, noteId });
          continue;
        }

        if (action.type === 'trash_note') {
          const noteId = this.resolveActionNoteId(action, lastCreatedNote);
          await this.notes.updateKey({ archived: false, trashed: true }, noteId);
          result.updatedNoteIds.push(noteId);
          result.executed.push({ type: action.type, noteId });
          continue;
        }

        throw new Error(`${action.type} requires an internet connection.`);
      } catch (error: any) {
        result.ok = false;
        result.failed.push({
          index,
          type: action.type,
          error: error?.message || String(error)
        });
        break;
      }
    }

    return result;
  }

  private normalizePlan(transcript: string, inputPlan: KeptActionPlan): KeptActionPlan {
    const actions: KeptAction[] = [];
    let createdNoteAvailable = false;

    for (const rawAction of inputPlan.actions || []) {
      const action = this.normalizeAction(rawAction);
      if (action.type === 'set_reminder' && !action.noteId && !createdNoteAvailable) {
        const noteText = this.reminderNoteText(action, transcript);
        actions.push({
          type: 'create_text_note',
          title: this.actionTitle(action) || noteText,
          text: this.actionText(action) || noteText
        });
        createdNoteAvailable = true;
      }
      actions.push(action);
      if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
        createdNoteAvailable = true;
      }
    }

    return {
      summary: String(inputPlan.summary || '').trim(),
      confidence: inputPlan.confidence || 'medium',
      requiresConfirmation: true,
      actions,
      unresolvedQuestions: [...(inputPlan.unresolvedQuestions || [])]
    };
  }

  private normalizeAction(rawAction: KeptAction): KeptAction {
    const raw = rawAction as any;
    const location = raw.location && typeof raw.location === 'object' ? raw.location : {};
    const action: any = {
      ...raw,
      type: String(raw.type || '').trim()
    };
    if (['archive', 'archiveNote'].includes(action.type)) action.type = 'archive_note';
    if (['trash', 'trashNote'].includes(action.type)) action.type = 'trash_note';
    const title = this.actionTitle(raw);
    const text = this.actionText(raw);
    if (title) action.title = title;
    if (text) action.text = text;
    if (raw.noteId || raw.targetNoteId || raw.targetId) {
      const noteId = Number(raw.noteId || raw.targetNoteId || raw.targetId);
      if (Number.isFinite(noteId) && noteId !== 0) action.noteId = noteId;
    }
    if (action.type === 'create_todo_note') action.items = this.checklistItems(raw);
    const labels = this.labelNames(raw);
    if (labels.length) action.labels = labels;
    const userIds = this.userIds(raw);
    if (userIds.length) action.userIds = userIds;
    action.dueAtUtc = raw.dueAtUtc || raw.dueAt || raw.datetime || raw.dateTime;
    action.locationName = raw.locationName || raw.location_name || raw.triggerLocationName
      || location.displayName || location.name || location.address;
    action.latitude = this.firstDefined(raw.latitude, raw.lat, location.latitude, location.lat);
    action.longitude = this.firstDefined(raw.longitude, raw.lng, raw.lon, location.longitude, location.lng, location.lon);
    action.radiusMeters = this.firstDefined(
      raw.radiusMeters, raw.radius_meters, raw.radius,
      location.radiusMeters, location.radius_meters, location.radius
    );
    action.locationTrigger = raw.locationTrigger || raw.location_trigger || raw.triggerType
      || location.locationTrigger || location.triggerType;
    return action as KeptAction;
  }

  private noteFromAction(action: KeptAction): NoteI {
    const isChecklist = action.type === 'create_todo_note';
    return {
      noteTitle: this.actionTitle(action),
      noteBody: this.actionText(action),
      pinned: false,
      bgColor: String(action.bgColor || ''),
      bgImage: '',
      checkBoxes: isChecklist
        ? this.checklistItems(action).map((item, index) => ({ id: Date.now() + index, data: item, done: false }))
        : [],
      images: [],
      isCbox: isChecklist,
      labels: [],
      archived: false,
      trashed: false,
      sortOrder: Date.now()
    };
  }

  private actionTitle(action: any) {
    return String(action?.title ?? action?.noteTitle ?? '').trim();
  }

  private actionText(action: any) {
    return String(action?.text ?? action?.body ?? action?.content ?? action?.noteBody ?? '').trim();
  }

  private checklistItems(action: any) {
    const raw = action?.items ?? action?.checklistItems ?? action?.todos ?? [];
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map(item => typeof item === 'string'
      ? item.trim()
      : String(item?.data ?? item?.text ?? item?.title ?? '').trim()
    ).filter(Boolean);
  }

  private labelNames(action: any) {
    const raw = action?.labels ?? action?.labelNames ?? action?.names ?? [];
    const labels = Array.isArray(raw) ? raw : [raw];
    return [...new Set(labels.map(label => typeof label === 'string'
      ? label.trim()
      : String(label?.name ?? '').trim()
    ).filter(Boolean))];
  }

  private userIds(action: any) {
    const raw = action?.userIds ?? action?.users ?? action?.collaboratorUserIds ?? action?.shareWithUserIds ?? [];
    const users = Array.isArray(raw) ? raw : [raw];
    return [...new Set(users
      .map(user => Number(typeof user === 'object' ? user?.id ?? user?.userId : user))
      .filter(Boolean)
    )];
  }

  private isLocationReminder(action: SetReminderAction) {
    return action.latitude != null
      && action.longitude != null
      && !!action.locationName
      && !!action.locationTrigger;
  }

  private hasAnyLocationField(action: SetReminderAction) {
    return action.latitude != null
      || action.longitude != null
      || !!action.locationName
      || !!action.locationTrigger;
  }

  private reminderNoteText(action: KeptAction, transcript: string) {
    return this.actionText(action)
      || this.actionTitle(action)
      || String(transcript || '')
        .replace(/\b(can you|please|could you)\b/gi, ' ')
        .replace(/\b(remind me|reminder|set a reminder|create a reminder)\b/gi, ' ')
        .replace(/\b(today|tomorrow|tonight|this evening|this morning|this afternoon)\b/gi, ' ')
        .replace(/\b(at|by|around)\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^\s*to\s+/i, '')
        .trim()
      || 'Reminder';
  }

  private firstDefined(...values: any[]) {
    return values.find(value => value !== undefined && value !== null && value !== '');
  }

  private noteTargetRequired(action: KeptAction) {
    return [
      'append_to_note',
      'add_checklist_items',
      'add_labels',
      'share_note',
      'archive_note',
      'trash_note'
    ].includes(action.type);
  }

  private resolveActionNoteId(action: KeptAction, lastCreatedNote: NoteI | null) {
    const noteId = Number((action as any).noteId || lastCreatedNote?.id || 0);
    if (!Number.isFinite(noteId) || noteId === 0) throw new Error(`${action.type} does not have a note.`);
    return noteId;
  }

  private async mergeLabels(current: any[], names: string[]) {
    const labels = [...(current || [])];
    const byName = new Map(labels.map(label => [String(label.name || '').toLowerCase(), label]));
    for (const name of names) {
      const key = name.toLowerCase();
      if (byName.has(key)) {
        byName.get(key).added = true;
        continue;
      }
      const label: any = { id: -Date.now() - labels.length, name, added: true };
      if (this.notes.isKept2LocalFirstActive()) {
        const stored = await this.localVault.upsertLabel({ name, syncId: `label-${crypto.randomUUID()}` } as any);
        label.syncId = stored.syncId;
      }
      labels.push(label);
      byName.set(key, label);
    }
    return labels;
  }

  private escapeHtml(value: string) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
