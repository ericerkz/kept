import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { LabelI, UpdateKeyI } from './../interfaces/labels';
import { AuthService } from './auth.service';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';
import { createUuid } from '../utils/uuid';

@Injectable({
  providedIn: 'root'
})
export class LabelsService {
  private readonly apiUrl = `${environment.apiUrl}/labels`;
  labelsList$ = new BehaviorSubject<LabelI[]>([]);

  constructor(private http: HttpClient, private auth: AuthService, private store: OfflineStoreService, private sync: OfflineSyncService) {
    this.sync.cacheChanged$.subscribe(() => { if (this.sync.writesLocally) this.load().catch(console.error); });
    this.auth.accessChanges$.subscribe(() => { this.labelsList$.next([]); if (this.auth.isLocal) this.load().catch(console.error); });
  }

  async load() {
    if (this.sync.writesLocally) {
      const partition = this.sync.partition;
      const labels = await this.store.listResources<LabelI>('label',partition);
      if (partition === this.sync.partition) this.labelsList$.next(this.uniqueLabels(labels)); return;
    }
    try {
      const labels = await firstValueFrom(this.http.get<LabelI[]>(this.apiUrl, { headers: this.auth.authHeaders() }));
      this.labelsList$.next(this.uniqueLabels(labels));
    } catch (error: any) {
      if (!navigator.onLine || error?.status === 0) {
        this.labelsList$.next(this.uniqueLabels(this.labelsList$.value));
        return;
      }
      throw error;
    }
  }

  async add(labelObj: LabelI) {
    const name = String(labelObj.name || '').trim();
    if (!name) throw new Error('Label name is required');

    const existing = this.labelsList$.value.find(label => label.name.toLowerCase() === name.toLowerCase());
    if (existing?.id != null) return existing.id;

    if (this.sync.writesLocally) {
      const value = await this.sync.commit('label.upsert', labelObj.syncId || `label-${createUuid()}`, { name });
      await this.load(); return (value as any).id as number;
    }
    if (!navigator.onLine) return this.addLocal(name);

    try {
      const label = await firstValueFrom(this.http.post<LabelI>(this.apiUrl, { ...labelObj, name }, { headers: this.auth.authHeaders() }));
      await this.load();
      return label.id;
    } catch (error: any) {
      if (error?.status === 0) return this.addLocal(name);
      throw error;
    }
  }

  async delete(id: number) {
    if (this.sync.writesLocally) {
      const value = this.labelsList$.value.find(label => label.id === id);
      if (value?.syncId) await this.sync.commit('label.delete', value.syncId, value);
      await this.load(); return;
    }
    try {
      await firstValueFrom(this.http.delete(`${this.apiUrl}/${id}`, { headers: this.auth.authHeaders() }));
      await this.load();
    } catch (error) {
      console.log(error)
      throw error
    }
  }

  async update(object: UpdateKeyI, id: number) {
    if (this.sync.writesLocally) {
      const value = this.labelsList$.value.find(label => label.id === id);
      if (!value?.syncId) throw new Error('Label unavailable.');
      const name = String(object.name ?? value.name).trim();
      if (!name) throw new Error('Label name is required.');
      await this.sync.commit('label.upsert', value.syncId, { ...value, name });
      await this.load(); return;
    }
    if (id !== -1) {
      try {
        await firstValueFrom(this.http.patch(`${this.apiUrl}/${id}`, object, { headers: this.auth.authHeaders() }));
        await this.load();
      } catch (error) {
        console.log(error)
        throw error
      }
    }
  }

  private addLocal(name: string) {
    let id = -Date.now();
    const usedIds = new Set(this.labelsList$.value.map(label => label.id));
    while (usedIds.has(id)) id -= 1;

    const labels = this.uniqueLabels([...this.labelsList$.value, { id, name }]);
    this.labelsList$.next(labels);
    return id;
  }

  private uniqueLabels(labels: LabelI[]) {
    const seen = new Set<string>();
    const unique: LabelI[] = [];
    for (const label of labels || []) {
      const name = String(label?.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ ...label, name });
    }
    return unique.sort((a, b) => this.compareLabels(a, b));
  }

  private compareLabels(a: LabelI, b: LabelI) {
    const byName = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    return byName || Number(a.id || 0) - Number(b.id || 0);
  }
}
