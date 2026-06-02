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

  get isAndroid(): boolean {
    return Capacitor.getPlatform() === 'android';
  }

  get supportsNativeLocationReminders(): boolean {
    return this.isIos || this.isAndroid;
  }

  async resolveLocation(phrase: string): Promise<LocationResolveResponse | null> {
    const plugin = this.locationResolutionPlugin();
    if (!plugin) return null;
    return plugin.resolveLocation({ phrase });
  }

  async requestLocationAccess(): Promise<{ granted: boolean } | null> {
    if (this.isAndroid) {
      const plugin = (window as any).Capacitor?.Plugins?.KeptGeofence;
      if (!plugin) return null;
      const status = await plugin.getPermissionStatus?.();
      if (status?.foregroundGranted && status?.backgroundGranted) return { granted: true };
      const foreground = status?.foregroundGranted ? status : await plugin.requestForegroundLocationPermission?.();
      if (!foreground?.foregroundGranted) return { granted: false };
      if (!foreground.backgroundGranted) await plugin.openBackgroundLocationSettings?.();
      return { granted: !!foreground.backgroundGranted };
    }

    const plugin = this.iosReminderPlugin();
    if (!plugin?.requestLocationAccess) return null;
    return plugin.requestLocationAccess();
  }

  async locationMapPreview(location: ResolvedLocation): Promise<string | null> {
    const plugin = this.locationPreviewPlugin();
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

  private iosReminderPlugin() {
    return (window as any).Capacitor?.Plugins?.KeptReminders;
  }

  private locationResolutionPlugin() {
    const plugins = (window as any).Capacitor?.Plugins;
    if (this.isIos) return plugins?.KeptIntelligence;
    if (this.isAndroid) {
      const candidates = [plugins?.KeptGeofence, plugins?.KeptSmartCapture];
      return candidates.find(plugin => typeof plugin?.resolveLocation === 'function');
    }
    return null;
  }

  private locationPreviewPlugin() {
    const plugins = (window as any).Capacitor?.Plugins;
    const candidates = this.isAndroid
      ? [plugins?.KeptGeofence, plugins?.KeptSmartCapture]
      : [plugins?.KeptReminders, plugins?.KeptIntelligence];
    return candidates.find(candidate => {
      const method = candidate?.locationMapPreview || candidate?.mapSnapshot || candidate?.getMapSnapshot;
      return typeof method === 'function';
    });
  }
}
