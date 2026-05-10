import { enableProdMode, provideZoneChangeDetection } from '@angular/core';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';
import { environment } from './environments/environment';

if (environment.production) {
  enableProdMode();
}

platformBrowserDynamic().bootstrapModule(AppModule, { applicationProviders: [provideZoneChangeDetection()], })
  .catch(err => console.error(err));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/kept-push-sw.js')
      .then(registration => registration.update())
      .catch(console.error);
  });
}

// iOS Safari ignores `user-scalable=no` in the viewport meta for accessibility
// reasons, so we intercept the iOS-specific gesture events that drive pinch
// and two-finger rotate. Cancelling them blocks page-level zoom without
// affecting regular taps, single-finger scrolling, or pointer-events-based
// gestures (e.g. the drawing canvas's two-finger pan/zoom, which reads from
// PointerEvent and is unaffected).
['gesturestart', 'gesturechange', 'gestureend'].forEach(name => {
  document.addEventListener(name, (event) => {
    event.preventDefault();
  }, { passive: false });
});
