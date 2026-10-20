import { NotesService } from './notes.service';
import { LabelsService } from './labels.service';
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { KeptAIContext, KeptActionPlan, KeptPlanExecution, KeptPlanValidation, NoteSummary } from '../interfaces/ai';
import { AuthService } from './auth.service';
import { ShareUserI } from '../interfaces/users';
import { LabelI } from '../interfaces/labels';

@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly apiUrl = environment.apiUrl;

  constructor(private http: HttpClient, private auth: AuthService, private notes: NotesService, private labels: LabelsService) {}

  async getContext(query?: string, currentOpenNoteId?: number) {
    if (this.auth.isLocal) {
      const notes = await this.searchNotes(query || '');
      await this.labels.load();
      return {currentUser:null,workspace:{id:this.auth.workspace.local!.id,generation:this.auth.workspace.local!.generation,mode:'local'},
        labels:this.labels.labelsList$.value,users:[],recentNotes:notes.slice(0,30),candidateNotes:notes.slice(0,30),currentOpenNote:notes.find(note=>note.id === currentOpenNoteId) || null} satisfies KeptAIContext;
    }
    const params: Record<string, string> = {};
    if (query) params['query'] = query;
    if (currentOpenNoteId) params['currentOpenNoteId'] = String(currentOpenNoteId);
    return await firstValueFrom(this.http.get<KeptAIContext>(`${this.apiUrl}/ai/context`, {
      headers: this.auth.authHeaders(),
      params
    }));
  }

  async validatePlan(transcript: string, actionPlan: KeptActionPlan) {
    return await firstValueFrom(this.http.post<KeptPlanValidation>(
      `${this.apiUrl}/ai/action-plan/validate`,
      { transcript, actionPlan },
      { headers: this.auth.authHeaders() }
    ));
  }

  async executePlan(
    transcript: string,
    actionPlan: KeptActionPlan,
    executeOptions: { allowPartial?: boolean; confirmed?: boolean; selectedActionIndexes?: number[] } = {}
  ) {
    return await firstValueFrom(this.http.post<KeptPlanExecution>(
      `${this.apiUrl}/ai/action-plan/execute`,
      { transcript, actionPlan, executeOptions },
      { headers: this.auth.authHeaders() }
    ));
  }

  async searchNotes(q: string): Promise<NoteSummary[]> {
    if (this.auth.isLocal) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return (await this.notes.getAll()).filter(note=>!note.trashed && !note.locked)
        .filter(note=>words.every(word=>`${note.noteTitle} ${note.noteBody} ${(note.checkBoxes || []).map(box=>box.data).join(' ')}`.toLowerCase().includes(word)))
        .sort((a,b)=>Date.parse(b.updatedAt || '')-Date.parse(a.updatedAt || ''))
        .map(note=>({id:note.id!,title:note.noteTitle,bodyPreview:note.noteBody || '',type:note.isCbox ? 'todo' : note.images?.length ? 'drawing' : 'text',labels:note.labels,
          checklistPreview:note.checkBoxes || [],updatedAt:note.updatedAt || '',collaboratorUserIds:[]}));
    }
    return await firstValueFrom(this.http.get<NoteSummary[]>(`${this.apiUrl}/notes/search`, {
      headers: this.auth.authHeaders(),
      params: { q }
    }));
  }

  async searchUsers(q: string) {
    if (this.auth.isLocal) return [];
    return await firstValueFrom(this.http.get<ShareUserI[]>(`${this.apiUrl}/users/search`, {
      headers: this.auth.authHeaders(),
      params: { q }
    }));
  }

  async findOrCreateLabel(name: string) {
    return await firstValueFrom(this.http.post<LabelI>(
      `${this.apiUrl}/labels/find-or-create`,
      { name },
      { headers: this.auth.authHeaders() }
    ));
  }

  async archiveNote(noteId: number) {
    return await firstValueFrom(this.http.post<{ ok: boolean; noteId: number; archived: boolean; trashed: boolean; trashedAt: string; updatedAt: string }>(
      `${this.apiUrl}/ai/notes/${noteId}/archive`,
      {},
      { headers: this.auth.authHeaders() }
    ));
  }

  async trashNote(noteId: number) {
    return await firstValueFrom(this.http.post<{ ok: boolean; noteId: number; archived: boolean; trashed: boolean; trashedAt: string; updatedAt: string }>(
      `${this.apiUrl}/ai/notes/${noteId}/trash`,
      {},
      { headers: this.auth.authHeaders() }
    ));
  }
}
