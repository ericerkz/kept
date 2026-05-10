import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { LabelI, UpdateKeyI } from './../interfaces/labels';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class LabelsService {
  private readonly apiUrl = `${environment.apiUrl}/labels`;
  labelsList$ = new BehaviorSubject<LabelI[]>([]);

  constructor(private http: HttpClient, private auth: AuthService) { }

  async load() {
    const labels = await firstValueFrom(this.http.get<LabelI[]>(this.apiUrl, { headers: this.auth.authHeaders() }));
    this.labelsList$.next(labels);
  }

  async add(labelObj: LabelI) {
    const label = await firstValueFrom(this.http.post<LabelI>(this.apiUrl, labelObj, { headers: this.auth.authHeaders() }));
    await this.load();
    return label.id;
  }

  async delete(id: number) {
    try {
      await firstValueFrom(this.http.delete(`${this.apiUrl}/${id}`, { headers: this.auth.authHeaders() }));
      await this.load();
    } catch (error) {
      console.log(error)
    }
  }

  async update(object: UpdateKeyI, id: number) {
    if (id !== -1) {
      try {
        await firstValueFrom(this.http.patch(`${this.apiUrl}/${id}`, object, { headers: this.auth.authHeaders() }));
        await this.load();
      } catch (error) {
        console.log(error)
      }
    }
  }
}

