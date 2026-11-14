import { NotesToolsPipe } from './notes-tools.pipe';
import { NotesComponent } from '../components/notes/notes.component';
import { NoteI } from '../interfaces/notes';
import { AuthService } from '../services/auth.service';
import { ReminderService } from '../services/reminder.service';

describe('label collection filtering', () => {
  const reservedNames = ['home', 'archived', 'trashed', 'shared', 'reminders', 'attachments',
    'binder:', 'binder:Work', 'shared-binder:', 'shared-binder:7', 'label:', 'label:archived'];
  const names = [...reservedNames, 'Archived', 'Work', 'client/work #1? 50% 中文'];
  const note = (id: number, overrides: Partial<NoteI> = {}): NoteI => ({
    id, syncId: `note-${id}`, noteTitle: 'Matching content', labels: [], archived: false,
    trashed: false, pinned: false, bgColor: '', bgImage: '', isCbox: false, ...overrides
  });
  let pipe: NotesToolsPipe;

  beforeEach(() => {
    pipe = new NotesToolsPipe(
      { reminders$: { value: [{ noteId: 8, status: 'pending', dueAtUtc: '2026-11-14' }] } } as unknown as ReminderService,
      { currentUser: { id: 1 } } as AuthService
    );
  });

  function pageType(page: object): string {
    const component = Object.create(NotesComponent.prototype);
    component.currentPage = page;
    component.updateCurrentPageName();
    return component.currentPageName;
  }

  for (const name of names) {
    it(`keeps the label "${name}" distinct from collection dispatch, including encoded routes`, () => {
      const component = Object.create(NotesComponent.prototype);
      const label = component.labelNameFromUrl(`/label/${encodeURIComponent(name)}?note=1#editor`);
      expect(label).toBe(name);
      const type = pageType({ label });
      expect(type).toBe(`label:${name}`);
      const labels = [{ name, added: true }];
      const active = note(1, { labels });
      const archived = note(2, { labels, archived: true });
      const shared = note(3, { labels, ownerUserId: 2 });
      const notes = [active, archived, shared, note(4, { labels, trashed: true }),
        note(5, { labels: [{ name, added: false }] }), note(6, { archived: true }),
        note(7, { binder: 'Work' }), note(8), note(9, { sharedBinder: {
          id: 7, name: 'Work', ownerUserId: 1, ownerDisplayName: '', ownerUsername: ''
        } })];
      expect(pipe.transform(notes, type)).toEqual([active, archived, shared]);
      expect(pipe.transform(notes, type, 'matching', 'all')).toEqual([active, archived, shared]);
      expect(pipe.transform(notes, type, 'matching', 'current', active.syncId)).toEqual([archived, shared]);
      expect(pipe.transform(notes, type, 'unmatched')).toEqual([]);
    });
  }

  it('preserves built-in, binder and shared-binder collections and search scopes', () => {
    const home = note(1);
    const archived = note(2, { archived: true });
    const trashed = note(3, { trashed: true });
    const shared = note(4, { ownerUserId: 2 });
    const binder = note(5, { binder: 'Work' });
    const sharedBinder = note(6, { sharedBinder: {
      id: 7, name: 'Team', ownerUserId: 2, ownerDisplayName: '', ownerUsername: ''
    } });
    const attachment = note(7, { hasAttachments: true });
    const reminder = note(8);
    const notes = [home, archived, trashed, shared, binder, sharedBinder, attachment, reminder];
    for (const [page, expected] of [
      [{ archive: true }, [archived]], [{ trash: true }, [trashed]],
      [{ shared: true }, [shared]], [{ attachments: true }, [attachment]],
      [{ reminders: true }, [reminder]], [{ binder: 'Work' }, [binder]],
      [{ sharedBinderId: 7 }, [sharedBinder]]
    ] as [object, NoteI[]][]) {
      expect(pipe.transform(notes, pageType(page))).toEqual(expected);
      expect(pipe.transform(notes, pageType(page), 'matching', 'current')).toEqual(expected);
    }
    const active = notes.filter(n => !n.archived && !n.trashed);
    expect(pipe.transform(notes, pageType({}))).toEqual(active.filter(n => !n.binder));
    for (const page of [{}, { binder: 'Work' }, { sharedBinderId: 7 }]) {
      expect(pipe.transform(notes, pageType(page), 'matching', 'all')).toEqual(active);
    }
  });

  it('keeps ordinary text and label-operator searches independent of collection dispatch', () => {
    const labelled = note(1, { labels: [{ name: 'archived', added: true }], noteTitle: 'Project plan' });
    const unrelated = note(2, { noteTitle: 'Other work' });
    const archived = note(3, { archived: true, noteTitle: 'Project plan' });
    const notes = [labelled, unrelated, archived];
    expect(pipe.transform(notes, 'home', 'project')).toEqual([labelled]);
    expect(pipe.transform(notes, 'home', '!label:archived')).toEqual([labelled]);
    expect(pipe.transform(notes, pageType({ label: 'archived' }), 'project')).toEqual([labelled]);
    expect(pipe.transform(notes, 'archived', 'project')).toEqual([archived]);
  });
});
