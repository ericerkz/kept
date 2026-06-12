import { Capacitor } from '@capacitor/core';

export const LEGACY_SMART_CAPTURE_KEY = 'kept_android_legacy_smart_capture_enabled';
export const ANDROID_SMART_CAPTURE_KEY = 'kept_android_smart_capture_enabled';

export function isAndroidPlatform(): boolean {
  return Capacitor.getPlatform() === 'android';
}

export function isIosPlatform(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

export function isNativePhonePlatform(): boolean {
  const platform = Capacitor.getPlatform();
  if (platform !== 'ios' && platform !== 'android') return false;
  const ua = navigator.userAgent || '';
  const navigatorPlatform = navigator.platform || '';
  if (platform === 'ios') {
    const isIPad = /iPad/i.test(ua)
      || /iPad/i.test(navigatorPlatform)
      || (navigatorPlatform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return !isIPad;
  }
  return /Mobile/i.test(ua);
}

export function shouldUseFullscreenNoteEditor(): boolean {
  const platform = Capacitor.getPlatform();
  if (platform === 'ios' || platform === 'android') return isNativePhonePlatform();
  return window.innerWidth < 660;
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

export function androidSmartCaptureEnabled(): boolean {
  try {
    return localStorage.getItem(ANDROID_SMART_CAPTURE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setAndroidSmartCaptureEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ANDROID_SMART_CAPTURE_KEY, enabled ? 'true' : 'false');
  } catch {}
}

export function androidSmartCaptureUiAllowed(): boolean {
  return androidSmartCaptureEnabled()
    && (!isLegacyAndroidSmartCaptureDevice() || legacyAndroidSmartCaptureEnabled());
}
