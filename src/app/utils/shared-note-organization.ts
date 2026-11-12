import { NoteI } from '../interfaces/notes';

export function projectSharedOrganization<T extends NoteI>(note: T, preferences: {
  inheritSharedLabels?: boolean; inheritSharedBinders?: boolean;
}): T {
  const organization = note.sharedOrganization;
  if (!organization) return note;
  return { ...note,
    labels: preferences.inheritSharedLabels !== false ? organization.ownerLabels : organization.personalLabels,
    binder: preferences.inheritSharedBinders !== false ? organization.ownerBinder : organization.personalBinder
  };
}

export function applyPersonalOrganization<T extends NoteI>(note: T, patch: Partial<Pick<NoteI, 'labels' | 'binder'>>): T {
  if (!note.sharedOrganization) return note;
  return { ...note, ...patch, sharedOrganization: { ...note.sharedOrganization,
    ...(patch.labels !== undefined ? { personalLabels: patch.labels } : {}),
    ...(patch.binder !== undefined ? { personalBinder: patch.binder } : {})
  } };
}

// Binder membership changes are field-only operations, separate from content autosaves.
export function applyBinderMembership<T extends NoteI>(note: T, patch: { binder?: string; sharedBinder?: NoteI['sharedBinder'] }): T {
  return { ...note, binder: patch.binder || '', sharedBinder: patch.sharedBinder,
    ...(note.sharedOrganization ? { sharedOrganization: { ...note.sharedOrganization, ownerBinder: patch.binder || '' } } : {}) };
}
