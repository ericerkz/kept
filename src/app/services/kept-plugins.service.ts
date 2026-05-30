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

export type LocationMapPreviewResponse =
  | string
  | { imageDataUrl?: string; dataUrl?: string; url?: string };

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

  async locationMapPreview(location: ResolvedLocation): Promise<string | null> {
    if (!this.isIos) return null;
    const plugins = (window as any).Capacitor?.Plugins;
    const plugin =
      [plugins?.KeptReminders, plugins?.KeptIntelligence]
        .find(candidate => {
          const method = candidate?.locationMapPreview || candidate?.mapSnapshot || candidate?.getMapSnapshot;
          return typeof method === 'function';
        });
    const previewMethod = plugin?.locationMapPreview || plugin?.mapSnapshot || plugin?.getMapSnapshot;
    if (typeof previewMethod !== 'function') return null;

    const response: LocationMapPreviewResponse = await previewMethod.call(plugin, {
      displayName: location.displayName,
      latitude: location.latitude,
      longitude: location.longitude,
      radiusMeters: location.radiusMeters
    });

    if (!response) return null;
    if (typeof response === 'string') return response;
    return response.imageDataUrl || response.dataUrl || response.url || null;
  }
}
