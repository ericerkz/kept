// iOS Safari is sensitive about SW lifecycle for PWA push registration.
// Don't aggressively skipWaiting / claim clients on every install —
// it can lead to the SW being treated as a different worker each load,
// which prevents the PWA from being listed in iOS Settings → Notifications.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match('/').then(response => response || Response.error()))
  );
});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || 'Reminder';
  const options = {
    body: data.body || undefined,
    icon: data.icon || '/assets/images/keep2x.png',
    badge: data.icon || '/assets/images/keep2x.png',
    tag: data.reminderId ? `kept-reminder-${data.reminderId}` : 'kept-reminder',
    renotify: true,
    data: {
      url: data.url || '/',
      reminderId: data.reminderId || null,
      noteId: data.noteId || null
    }
  };

  // iOS Safari requires every push event to result in showNotification(),
  // or it will throttle and eventually revoke the push subscription.
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach(client => {
      try { client.postMessage({ type: 'push-reminder-fired', payload: data }); } catch {}
    });
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = new URL(data.url || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        try { client.postMessage({ type: 'notification-click', payload: data }); } catch {}
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});
