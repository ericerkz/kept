// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

// Allow the host page to override the API base URL at runtime by setting
// `window.KEPT_API_URL` BEFORE the Angular bundle loads. This is what the
// native Capacitor shell (iOS/Android) uses to point the bundled web app at
// a remote Kept server, since `capacitor://localhost` can't serve `/api`.
// In standard web deployments where the SPA and API live at the same origin,
// the override is undefined and the relative `/api` path is used as before.
declare const window: Window & { KEPT_API_URL?: string };
const runtimeApiBase = (typeof window !== 'undefined' && typeof window.KEPT_API_URL === 'string')
  ? window.KEPT_API_URL.replace(/\/$/, '')
  : '';

export const environment = {
  production: false,
  apiUrl: runtimeApiBase ? `${runtimeApiBase}/api` : '/api'
};

/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.
