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
