import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';
import { createUuid } from '../utils/uuid';

export type LocationTrigger = 'arrive' | 'leave';
export type SavedPlaceType = 'home' | 'work' | 'gym' | 'other';

export interface LocationSavedPlace {
  id: number;
  syncId?: string;
  userId?: number;
  name: string;
  address: string;
  placeType: SavedPlaceType;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  locationTrigger: LocationTrigger;
  mapPreviewUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LocationSavedPlacePayload = {
  name: string;
  address?: string;
  placeType?: SavedPlaceType;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  locationTrigger: LocationTrigger;
  mapPreviewUrl?: string | null;
};

@Injectable({ providedIn: 'root' })
export class LocationSavedPlacesService {
  private readonly apiUrl = environment.apiUrl;

  constructor(private http: HttpClient, private auth: AuthService, private offlineStore: OfflineStoreService, private sync: OfflineSyncService) {
    this.auth.accessChanges$.subscribe(user => {
      if (!this.auth.isLocal && user && navigator.onLine) this.list().catch(console.error);
    });
  }

  async list() {
    const partition = this.partition();
    if (this.sync.writesLocally || !navigator.onLine) return partition ? this.offlineStore.listSavedPlaces(partition) : [];
    try {
      const places = await firstValueFrom(
        this.http.get<LocationSavedPlace[]>(`${this.apiUrl}/location-saved-places`, { headers: this.auth.authHeaders() })
      );
      if (this.sync.writesLocally) return this.offlineStore.listSavedPlaces(partition);
      if (partition) await this.offlineStore.replaceSavedPlaces(partition, places);
      return places;
    } catch (error: any) {
      if (partition && (!navigator.onLine || error?.status === 0)) {
        return this.offlineStore.listSavedPlaces(partition);
      }
      throw error;
    }
  }

  async create(payload: LocationSavedPlacePayload) {
    if (this.sync.writesLocally) return this.saveLocal(payload);
    const place = await firstValueFrom(
      this.http.post<LocationSavedPlace>(`${this.apiUrl}/location-saved-places`, payload, { headers: this.auth.authHeaders() })
    );
    await this.refreshCache();
    return place;
  }

  async update(id: number, payload: Partial<LocationSavedPlacePayload>, syncId?: string) {
    if (this.sync.writesLocally) {
      // A connected workspace can receive the server's numeric id while the
      // editor is open. Its sync identity stays the same throughout.
      const value = (await this.list()).find(place => syncId ? place.syncId === syncId : place.id === id);
      if (!value) throw new Error('Saved place unavailable.');
      return this.saveLocal({ ...value, ...payload }, value);
    }
    const place = await firstValueFrom(
      this.http.patch<LocationSavedPlace>(`${this.apiUrl}/location-saved-places/${id}`, payload, { headers: this.auth.authHeaders() })
    );
    await this.refreshCache();
    return place;
  }

  async delete(id: number) {
    if (this.sync.writesLocally) {
      const value = (await this.list()).find(place => place.id === id);
      if (value?.syncId) await this.sync.commit('savedPlace.delete', value.syncId, value);
      return;
    }
    await firstValueFrom(
      this.http.delete<void>(`${this.apiUrl}/location-saved-places/${id}`, { headers: this.auth.authHeaders() })
    );
    await this.refreshCache();
  }

  private async saveLocal(payload: Partial<LocationSavedPlacePayload>, previous?: LocationSavedPlace) {
    if (!Number.isFinite(payload.latitude) || !Number.isFinite(payload.longitude) || Math.abs(payload.latitude!) > 90 || Math.abs(payload.longitude!) > 180) throw new Error('Choose a valid location.');
    if (!String(payload.name || '').trim()) throw new Error('A place name is required.');
    return await this.sync.commit('savedPlace.upsert', previous?.syncId || `place-${createUuid()}`, {
      userId: this.auth.currentUser?.id, address: '', placeType: 'other', locationTrigger: 'arrive', ...previous, ...payload,
      name: String(payload.name).trim(), radiusMeters: Math.max(50, Math.min(10000, Number(payload.radiusMeters || 120)))
    }) as unknown as LocationSavedPlace;
  }

  private partition() {
    return this.sync.partition;
  }

  private async refreshCache() {
    if (!navigator.onLine) return;
    const partition = this.partition();
    if (!partition) return;
    const places = await firstValueFrom(
      this.http.get<LocationSavedPlace[]>(`${this.apiUrl}/location-saved-places`, { headers: this.auth.authHeaders() })
    );
    await this.offlineStore.replaceSavedPlaces(partition, places);
  }
}
