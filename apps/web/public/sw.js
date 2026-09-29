// Service worker for admin web push (client-012). Registered by the admin
// settings screen with scope /admin/ only. It does nothing but show a push
// and open its link: no caching, no fetch handler.
// The payload is {title, body, url, tag}: order number and link only (SEC-018).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' ? data.title : '';
  if (!title) return;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      data: { url: typeof data.url === 'string' ? data.url : '/admin/orders' },
      lang: 'he',
      dir: 'rtl',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Only open pages of this site: a link to anywhere else becomes the orders list.
  let target;
  try {
    target = new URL(event.notification.data && event.notification.data.url, self.location.origin);
  } catch {
    target = new URL('/admin/orders', self.location.origin);
  }
  if (target.origin !== self.location.origin) target = new URL('/admin/orders', self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          return w.navigate(target.href).then((c) => (c || w).focus());
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
