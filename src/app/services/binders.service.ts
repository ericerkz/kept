import { AuthService } from './auth.service';
import { environment } from 'src/environments/environment';
import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { CatalogItem } from '../interfaces/workspace';
import { createUuid } from '../utils/uuid';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';

@Injectable({ providedIn: 'root' })
export class BindersService {
  private migratingLegacy = false;
  readonly items$ = new BehaviorSubject<CatalogItem[]>([]);
  constructor(private store: OfflineStoreService, public sync: OfflineSyncService,private auth: AuthService) {
    this.sync.cacheChanged$.subscribe(() => this.load().catch(console.error));
  }
  async load() {
    if (!this.sync.partition) { this.items$.next([]); return; }
    const partition = this.sync.partition;
    let items = await this.store.listResources<CatalogItem>('binder', partition);
    if (partition !== this.sync.partition) return;
    if (!this.auth.isLocal && this.sync.writesLocally && this.auth.currentUser) {
      const legacyKey = `kept_binders_v1:${environment.apiUrl || location.origin}:${this.auth.currentUser.id}`;
      const marker = `${legacyKey}:workspace-migrated`;
      if (localStorage.getItem(marker) !== 'done' && !this.migratingLegacy) {
        // Mark before emitting committed changes to avoid recursive migration.
        this.migratingLegacy = true;
        try {
          const names = JSON.parse(localStorage.getItem(legacyKey) || '[]');
          for (const name of names) if (typeof name === 'string' && name.trim() && !items.some(item=>item.name.toLowerCase() === name.trim().toLowerCase())) {
            if (partition !== this.sync.partition) return;
            await this.sync.commit('binder.upsert',`binder-${createUuid()}`,{name:name.trim().slice(0,80)});
          }
          localStorage.setItem(marker,'done');
          items = await this.store.listResources<CatalogItem>('binder', this.sync.partition);
        } catch(error) {localStorage.removeItem(marker);throw error;} finally {this.migratingLegacy = false;}
      }
    }
    if (partition !== this.sync.partition) return;
    items = [...new Map(items.map(item=>[item.name.toLowerCase(),item])).values()];
    this.items$.next(items.sort((a, b) => a.name.localeCompare(b.name)));
  }
  async save(name: string, oldName?: string) {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error('Binder name is required.');
    const previous = this.items$.value.find(item => item.name.toLowerCase() === (oldName || name).toLowerCase());
    await this.sync.commit('binder.upsert', previous?.syncId || `binder-${createUuid()}`, { ...previous, name: clean });
    await this.load();
  }
  async delete(name: string) {
    const previous = this.items$.value.find(item => item.name === name);
    if (previous) await this.sync.commit('binder.delete', previous.syncId, previous);
    await this.load();
  }
}
