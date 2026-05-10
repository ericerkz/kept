// See environment.ts for the rationale behind window.KEPT_API_URL.
declare const window: Window & { KEPT_API_URL?: string };
const runtimeApiBase = (typeof window !== 'undefined' && typeof window.KEPT_API_URL === 'string')
  ? window.KEPT_API_URL.replace(/\/$/, '')
  : '';

export const environment = {
  production: true,
  apiUrl: runtimeApiBase ? `${runtimeApiBase}/api` : '/api'
};
