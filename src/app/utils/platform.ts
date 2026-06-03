import { Capacitor } from '@capacitor/core';

export const LEGACY_SMART_CAPTURE_KEY = 'kept_android_legacy_smart_capture_enabled';

export function isAndroidPlatform(): boolean {
  return Capacitor.getPlatform() === 'android';
}

export function isIosPlatform(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

export function androidMajorVersion(): number | null {
  const match = navigator.userAgent.match(/Android\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function isLegacyAndroidSmartCaptureDevice(): boolean {
  const major = androidMajorVersion();
  return isAndroidPlatform() && major !== null && major <= 12;
}

export function legacyAndroidSmartCaptureEnabled(): boolean {
  try {
    return localStorage.getItem(LEGACY_SMART_CAPTURE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setLegacyAndroidSmartCaptureEnabled(enabled: boolean) {
  try {
    localStorage.setItem(LEGACY_SMART_CAPTURE_KEY, enabled ? 'true' : 'false');
  } catch {}
}

export function androidSmartCaptureUiAllowed(): boolean {
  return !isLegacyAndroidSmartCaptureDevice() || legacyAndroidSmartCaptureEnabled();
}
