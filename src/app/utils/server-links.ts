import { Capacitor } from '@capacitor/core';
import { environment } from 'src/environments/environment';

/** Absolute public link to an API route, including when the UI is bundled locally. */
export function serverApiUrl(path: string): string {
  const api = environment.apiUrl.replace(/\/+$/, '');
  const url = `${api}/${path.replace(/^\/+/, '')}`;
  if (/^https?:\/\//i.test(api)) return new URL(url).href;
  // The local native origin is never a usable server address for other apps.
  if (Capacitor.isNativePlatform()) throw new Error('Connect to your Kept server before creating a server link.');
  return new URL(url, document.baseURI).href;
}
