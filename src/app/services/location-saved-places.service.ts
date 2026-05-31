import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';

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

  constructor(private http: HttpClient, private auth: AuthService) {}

  list() {
    return firstValueFrom(
      this.http.get<LocationSavedPlace[]>(`${this.apiUrl}/location-saved-places`, { headers: this.auth.authHeaders() })
    );
  }

  create(payload: LocationSavedPlacePayload) {
    return firstValueFrom(
      this.http.post<LocationSavedPlace>(`${this.apiUrl}/location-saved-places`, payload, { headers: this.auth.authHeaders() })
    );
  }

  update(id: number, payload: Partial<LocationSavedPlacePayload>) {
    return firstValueFrom(
      this.http.patch<LocationSavedPlace>(`${this.apiUrl}/location-saved-places/${id}`, payload, { headers: this.auth.authHeaders() })
    );
  }

  delete(id: number) {
    return firstValueFrom(
      this.http.delete<void>(`${this.apiUrl}/location-saved-places/${id}`, { headers: this.auth.authHeaders() })
    );
  }
}
