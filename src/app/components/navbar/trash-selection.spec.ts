import { CommonModule } from '@angular/common';
import { HttpClient, HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTranslateService, TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { NavbarComponent } from './navbar.component';
import { NotesComponent } from '../notes/notes.component';
import { SharedService } from '../../services/shared.service';
import { AuthService } from '../../services/auth.service';
import { OfflineSyncService } from '../../services/offline-sync.service';
import { NotesService } from '../../services/notes.service';
import { UiTextPipe } from '../../i18n/ui-text.pipe';

describe('Trash selection deletion', () => {
  let shared: any;
  let originalSnackbar: any;

  beforeEach(async () => {
    originalSnackbar = (window as any).Snackbar;
    shared = {
      selectedNoteIds: new BehaviorSubject([1, 2]),
      deleteSelectedForever: new Subject<void>(),
      bulkTrashSelected: jasmine.createSpy('bulkTrashSelected'),
      clearNoteSelection() { this.selectedNoteIds.next([]); },
      selectionOrganizationHint: () => '',
      canOrganizeSelection: () => false,
      note: { all: [], pinned: [], unpinned: [] }
    };
    spyOn(NavbarComponent.prototype, 'ngOnInit');
    await TestBed.configureTestingModule({
      declarations: [NavbarComponent, UiTextPipe],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
      imports: [CommonModule, TranslatePipe],
      providers: [
        provideTranslateService(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: SharedService, useValue: shared },
        { provide: AuthService, useValue: {} },
        { provide: OfflineSyncService, useValue: {
          state$: new BehaviorSubject('saved'), pendingCount$: new BehaviorSubject(0),
          lastSyncedAt$: new BehaviorSubject(null), storageBlocked$: new BehaviorSubject(false)
        } }
      ]
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      'common.delete': 'Delete', 'accessibility.delete_forever': 'Delete forever'
    });
    translate.use('en');
  });

  afterEach(() => { (window as any).Snackbar = originalSnackbar; });

  for (const url of ['/trash', '/trash?search=test', '/notes']) {
    it(`labels and routes the bulk delete action on ${url}`, () => {
      spyOnProperty(TestBed.inject(Router), 'url', 'get').and.returnValue(url);
      const requested = jasmine.createSpy('permanent delete request');
      shared.deleteSelectedForever.subscribe(requested);
      const fixture = TestBed.createComponent(NavbarComponent);
      fixture.detectChanges();
      const button = fixture.nativeElement.querySelector('.selection-icon.delete') as HTMLButtonElement;
      const inTrash = url.startsWith('/trash');
      expect(button.getAttribute('data-pop')).toBe(inTrash ? 'Delete forever' : 'Delete');
      expect(button.getAttribute('aria-label')).toBe(inTrash ? 'Delete forever' : 'Delete');
      button.click();
      expect(requested.calls.count()).toBe(inTrash ? 1 : 0);
      expect(shared.bulkTrashSelected.calls.count()).toBe(inTrash ? 0 : 1);
      const menuAction = fixture.nativeElement.querySelector('.selectionMoreMenu > div') as HTMLElement;
      if (inTrash) expect(menuAction.textContent?.trim()).toBe('Delete forever');
      menuAction.click();
      expect(requested.calls.count()).toBe(inTrash ? 2 : 0);
      expect(shared.bulkTrashSelected.calls.count()).toBe(inTrash ? 0 : 2);
      fixture.destroy();
    });
  }

  function notesHarness() {
    const notes = Object.create(NotesComponent.prototype) as any;
    const selected = [
      { id: 1, ownerUserId: 7, trashed: true, pinned: false },
      { id: 2, ownerUserId: 7, trashed: true, pinned: false },
      { id: 3, ownerUserId: 8, trashed: true, pinned: false },
      { id: 4, ownerUserId: 7, trashed: false, pinned: false },
      { id: 5, ownerUserId: 7, trashed: true, pinned: false }
    ];
    shared.note = { all: [...selected], pinned: [], unpinned: [...selected] };
    shared.selectedNoteIds.next([1, 2, 3, 4]);
    Object.assign(notes, {
      Shared: shared, auth: { currentUser: { id: 7 } },
      pendingPermanentDeletes: new Map(), masonrySignatureToken: 0,
      cd: { detectChanges() {} }, scheduleBuildMasonry() {},
      notesService: { delete: jasmine.createSpy('delete').and.resolveTo() }
    });
    const messages: any[] = [];
    (window as any).Snackbar = { show: (message: any) => messages.push(message) };
    return { notes, messages };
  }

  it('permanently deletes only selected owned Trash notes after the card undo window', fakeAsync(() => {
    const { notes, messages } = notesHarness();
    notes.removeSelectedNotes();
    expect(shared.note.all.map((note: any) => note.id)).toEqual([3, 4, 5]);
    expect(shared.selectedNoteIds.value).toEqual([]);
    expect(notes.notesService.delete).not.toHaveBeenCalled();
    expect(messages.at(-1).actionText).toBe('Undo');
    tick(4999);
    expect(notes.notesService.delete).not.toHaveBeenCalled();
    tick(1);
    expect(notes.notesService.delete.calls.allArgs()).toEqual([[1], [2]]);
  }));

  it('undo restores every selected note and cancels every permanent deletion', fakeAsync(() => {
    const { notes, messages } = notesHarness();
    notes.removeSelectedNotes();
    messages.at(-1).onActionClick();
    tick(5000);
    expect(shared.note.all.map((note: any) => note.id)).toEqual([1, 2, 3, 4, 5]);
    expect(notes.notesService.delete).not.toHaveBeenCalled();
    expect(notes.pendingPermanentDeletes.size).toBe(0);
  }));

  it('uses the same permanent HTTP DELETE path as cards, not a Trash update', fakeAsync(() => {
    const { notes } = notesHarness();
    const service = Object.create(NotesService.prototype);
    Object.assign(service, {
      notesList$: new BehaviorSubject([...shared.note.all]),
      auth: { currentUser: { id: 7 }, authHeaders: () => new HttpHeaders() },
      offlineSync: { writesLocally: false },
      reminders: { markNoteInactive() {} },
      http: TestBed.inject(HttpClient), apiUrl: '/api/notes', load: async () => {}
    });
    notes.notesService = service;
    notes.removeSelectedNotes();
    const http = TestBed.inject(HttpTestingController);
    http.expectNone('/api/notes/1');
    tick(5000);
    for (const id of [1, 2]) {
      const request = http.expectOne(`/api/notes/${id}`);
      expect(request.request.method).toBe('DELETE');
      request.flush({});
    }
    tick();
    http.verify();
  }));

  it('keeps the existing per-card deletion and undo path', fakeAsync(() => {
    const { notes, messages } = notesHarness();
    notes.removeNote(shared.note.all[0]);
    expect(shared.note.all.map((note: any) => note.id)).toEqual([2, 3, 4, 5]);
    messages.at(-1).onActionClick();
    tick(5000);
    expect(shared.note.all.map((note: any) => note.id)).toEqual([1, 2, 3, 4, 5]);
    expect(notes.notesService.delete).not.toHaveBeenCalled();
  }));
});
