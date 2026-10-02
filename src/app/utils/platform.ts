import { Capacitor } from '@capacitor/core';

export const LEGACY_SMART_CAPTURE_KEY = 'kept_android_legacy_smart_capture_enabled';
export const ANDROID_SMART_CAPTURE_KEY = 'kept_android_smart_capture_enabled';

export function isAndroidPlatform(): boolean {
  return Capacitor.getPlatform() === 'android';
}

export function isIosPlatform(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

function hasMultipleWindowSegments(): boolean {
  try {
    const getWindowSegments = (window as typeof window & {
      getWindowSegments?: () => DOMRect[];
    }).getWindowSegments;
    return typeof getWindowSegments === 'function' && getWindowSegments.call(window).length > 1;
  } catch {
    return false;
  }
}

function isLikelyAndroidBookFoldable(): boolean {
  const width = window.screen.width || window.innerWidth;
  const height = window.screen.height || window.innerHeight;
  const shortestSide = Math.min(width, height);
  const longestSide = Math.max(width, height);
  if (!shortestSide || !longestSide) return false;

  // Unfolded book-style phones have a nearly square screen. Keep this
  // deliberately below 4:3 so ordinary Android tablets retain tablet UI.
  return longestSide / shortestSide <= 1.28;
}

export function isExpandedNativeFoldable(): boolean {
  const platform = Capacitor.getPlatform();
  if (platform !== 'ios' && platform !== 'android') return false;
  if (!isNativePhonePlatform()) return false;
  if (hasMultipleWindowSegments()) return true;

  const width = window.screen.width || window.innerWidth;
  const height = window.screen.height || window.innerHeight;
  const shortestSide = Math.min(width, height);
  const longestSide = Math.max(width, height);
  return !!shortestSide && longestSide / shortestSide <= 1.28;
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
    // Use both screen and viewport dimensions because some shells expose
    // physical screen pixels. Current iPhones stay below 1000 CSS pixels on
    // their long side, while iPads begin at 1024.
    const shortestScreenSide = Math.min(window.screen.width, window.screen.height);
    const longestViewportSide = Math.max(window.innerWidth, window.innerHeight);
    return shortestScreenSide < 600 || longestViewportSide < 1000;
  }
  if (/Mobile/i.test(ua)) return true;
  if (Math.min(window.screen.width, window.screen.height) < 600) return true;
  return hasMultipleWindowSegments() || isLikelyAndroidBookFoldable();
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
