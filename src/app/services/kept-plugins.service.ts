import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';

export interface ResolvedLocation {
  displayName: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  confidence: 'high' | 'medium' | 'low';
  source: 'savedLocation' | 'geocoder' | 'localSearch';
}

export type LocationResolveResponse =
  | { status: 'resolved'; location: ResolvedLocation }
  | { status: 'ambiguous'; candidates: ResolvedLocation[] }
  | { status: 'notFound' }
  | { status: 'needsLocationPermission'; reason: string };

@Injectable({ providedIn: 'root' })
export class KeptPluginsService {
  get isIos(): boolean {
    return Capacitor.getPlatform() === 'ios';
  }

  async resolveLocation(phrase: string): Promise<LocationResolveResponse | null> {
    if (!this.isIos) return null;
    const plugin = (window as any).Capacitor?.Plugins?.KeptIntelligence;
    if (!plugin) return null;
    return plugin.resolveLocation({ phrase });
  }

  async requestLocationAccess(): Promise<{ granted: boolean } | null> {
    if (!this.isIos) return null;
    const plugin = (window as any).Capacitor?.Plugins?.KeptReminders;
    if (!plugin) return null;
    return plugin.requestLocationAccess();
  }
}