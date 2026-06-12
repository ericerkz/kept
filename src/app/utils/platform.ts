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
    if (/iPhone|iPod/i.test(ua) || /iPhone|iPod/i.test(navigatorPlatform)) return true;
    if (/iPad/i.test(ua) || /iPad/i.test(navigatorPlatform)) return false;

    // Some native WKWebViews identify both iPhone and iPad as MacIntel.
    // Their shortest CSS screen dimensions remain clearly separated:
    // current iPhones are below 600pt while iPads start well above it.
    const shortestScreenSide = Math.min(window.screen.width, window.screen.height);
    return shortestScreenSide < 600;
  }
  if (/Mobile/i.test(ua)) return true;
  return Math.min(window.screen.width, window.screen.height) < 600;
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
