import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';
import { OfflineStoreService } from './offline-store.service';

export type LocationTrigger = 'arrive' | 'leave';
export type SavedPlaceType = 'home' | 'work' | 'gym' | 'other';

export interface LocationSavedPlace {
  id: number;
  userId: number;
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

  constructor(private http: HttpClient, private auth: AuthService, private offlineStore: OfflineStoreService) {
    this.auth.currentUser$.subscribe(user => {
      if (user && navigator.onLine) this.list().catch(console.error);
    });
  }

  async list() {
    const partition = this.partition();
    if (!navigator.onLine) return partition ? this.offlineStore.listSavedPlaces(partition) : [];
    try {
      const places = await firstValueFrom(
        this.http.get<LocationSavedPlace[]>(`${this.apiUrl}/location-saved-places`, { headers: this.auth.authHeaders() })
      );
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
    const place = await firstValueFrom(
      this.http.post<LocationSavedPlace>(`${this.apiUrl}/location-saved-places`, payload, { headers: this.auth.authHeaders() })
    );
    await this.refreshCache();
    return place;
  }

  async update(id: number, payload: Partial<LocationSavedPlacePayload>) {
    const place = await firstValueFrom(
      this.http.patch<LocationSavedPlace>(`${this.apiUrl}/location-saved-places/${id}`, payload, { headers: this.auth.authHeaders() })
    );
    await this.refreshCache();
    return place;
  }

  async delete(id: number) {
    await firstValueFrom(
      this.http.delete<void>(`${this.apiUrl}/location-saved-places/${id}`, { headers: this.auth.authHeaders() })
    );
    await this.refreshCache();
  }

  private partition() {
    return this.auth.currentUser?.id ? this.offlineStore.partition(this.auth.currentUser.id) : '';
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
