import { NotesToolsPipe } from './notes-tools.pipe';
import { NoteI } from '../interfaces/notes';

describe('NotesToolsPipe date and literal year search', () => {
  const note = (values: Partial<NoteI>): NoteI => ({
    noteTitle: '', noteBody: '', pinned: false, bgColor: '', bgImage: '',
    isCbox: false, labels: [], archived: false, trashed: false,
    createdAt: new Date(2026, 10, 14, 12).toISOString(), ...values
  });
  let pipe: NotesToolsPipe;

  beforeEach(() => {
    // Home search does not use either service.
    pipe = new NotesToolsPipe(null!, null!);
  });

  it('finds bare years in titles and bodies, not in creation timestamps', () => {
    const title = note({ noteTitle: 'Title with 1999' });
    const body = note({ noteBody: '<p>Memories of 1999</p>' });
    const old = note({ noteTitle: 'Unrelated', createdAt: new Date(1999, 5, 1).toISOString() });
    expect(pipe.transform([title, body, old], 'home', '1999')).toEqual([title, body]);
  });

  it('requires both the literal year and other text, including with operators', () => {
    const match = note({ noteTitle: 'Budget 1999', isCbox: true });
    const wrongYear = note({ noteTitle: 'Budget 2000', isCbox: true });
    const wrongText = note({ noteTitle: 'Memories 1999', isCbox: true });
    const noTodos = note({ noteTitle: 'Budget 1999' });
    const notes = [match, wrongYear, wrongText, noTodos];
    expect(pipe.transform(notes, 'home', 'budget 1999')).toEqual([match, noTodos]);
    expect(pipe.transform(notes, 'home', '1999 budget !todo')).toEqual([match]);
    expect(pipe.transform(notes, 'home', '2000')).toEqual([wrongYear]);
  });

  for (const query of ['created 1999', 'from 1999', 'notes created from 1999', 'june 1999']) {
    it(`preserves the explicit date expression "${query}"`, () => {
      const old = note({ createdAt: new Date(1999, 5, 1, 12).toISOString() });
      const recent = note({ noteTitle: '1999' });
      expect(pipe.transform([old, recent], 'home', query)).toEqual([old]);
    });
  }

  for (const query of ['2026-11-14', '2026/11/14', '2026-11', 'created 2026']) {
    it(`preserves numeric date search "${query}" combined with text and operators`, () => {
      const match = note({ noteTitle: 'Budget', isCbox: true });
      const wrongDate = note({ noteTitle: 'Budget', isCbox: true, createdAt: new Date(2025, 10, 14).toISOString() });
      const wrongText = note({ noteTitle: 'Memories', isCbox: true });
      expect(pipe.transform([match, wrongDate, wrongText], 'home', `${query} budget !todo`)).toEqual([match]);
    });
  }

  for (const query of ['today', 'yesterday', 'last month', 'last year', 'created from two years ago']) {
    it(`preserves relative date search "${query}"`, () => {
      jasmine.clock().install();
      try {
        jasmine.clock().mockDate(new Date(2026, 10, 14, 12));
        const dates = ['2026-11-14T12:00:00', '2026-11-13T12:00:00', '2026-10-15T12:00:00', '2025-06-01T12:00:00', '2024-06-01T12:00:00'];
        const notes = dates.map(createdAt => note({ createdAt }));
        expect(pipe.transform(notes, 'home', query)).toEqual([notes[
          ['today', 'yesterday', 'last month', 'last year', 'created from two years ago'].indexOf(query)
        ]]);
      } finally {
        jasmine.clock().uninstall();
      }
    });
  }
});
