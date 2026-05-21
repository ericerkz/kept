import { LabelI } from './labels';
import { ShareUserI, UserI } from './users';

export type KeptActionConfidence = 'low' | 'medium' | 'high';

export interface NoteSummary {
  id: number;
  title: string;
  bodyPreview: string;
  type: 'text' | 'todo' | 'drawing';
  labels: LabelI[];
  checklistPreview: { id?: number; data: string; done: boolean }[];
  updatedAt: string;
  ownerUserId: number;
  collaboratorUserIds: number[];
}

interface BaseAction {
  type: string;
  title?: string;
  text?: string;
  noteId?: number;
}

export interface CreateTextNoteAction extends BaseAction {
  type: 'create_text_note';
}

export interface CreateTodoNoteAction extends BaseAction {
  type: 'create_todo_note';
  items: string[];
}

export interface AppendToNoteAction extends BaseAction {
  type: 'append_to_note';
  noteId: number;
}

export interface AddChecklistItemsAction extends BaseAction {
  type: 'add_checklist_items';
  noteId: number;
  items: string[];
}

export interface AddLabelsAction extends BaseAction {
  type: 'add_labels';
  noteId: number;
  labels: string[];
}

export interface SetReminderAction extends BaseAction {
  type: 'set_reminder';
  noteId?: number;
  dueAtUtc?: string;
  timezone?: string;
  repeatRule?: string;
}

export interface ShareNoteAction extends BaseAction {
  type: 'share_note';
  noteId: number;
  userIds: number[];
}

export type KeptAction =
  | CreateTextNoteAction
  | CreateTodoNoteAction
  | AppendToNoteAction
  | AddChecklistItemsAction
  | AddLabelsAction
  | SetReminderAction
  | ShareNoteAction
  | BaseAction;

export interface KeptActionPlan {
  summary: string;
  confidence: KeptActionConfidence;
  requiresConfirmation: boolean;
  actions: KeptAction[];
  unresolvedQuestions?: string[];
}

export interface KeptAIContext {
  currentUser: UserI;
  labels: LabelI[];
  users: ShareUserI[];
  recentNotes: NoteSummary[];
  candidateNotes: NoteSummary[];
  currentOpenNote?: NoteSummary | null;
}

export interface KeptPlanValidation {
  valid: boolean;
  ok: boolean;
  errors: string[];
  warnings?: string[];
  normalizedPlan: KeptActionPlan;
  requiresConfirmation: boolean;
}

export interface KeptPlanExecution {
  ok: boolean;
  executed: any[];
  failed: any[];
  createdNoteIds: number[];
  updatedNoteIds: number[];
  createdLabelIds: number[];
  reminderIds: number[];
}
