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

  constructor(private http: HttpClient, private auth: AuthService) {}

  async getContext(query?: string, currentOpenNoteId?: number) {
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

  async searchNotes(q: string) {
    return await firstValueFrom(this.http.get<NoteSummary[]>(`${this.apiUrl}/notes/search`, {
      headers: this.auth.authHeaders(),
      params: { q }
    }));
  }

  async searchUsers(q: string) {
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
}
