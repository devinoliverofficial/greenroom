/* Greenroom service worker.
   Network-first for everything, falling back to cache when offline — so a new
   deploy is picked up on the next open, and a tour bus with no signal still
   gets the app shell. The cache name carries the build stamp; installing a new
   version clears the old cache. */
var CACHE = 'greenroom-20260925-024148';
var SHELL = ['./', 'index.html', 'core.js', 'statements.js', 'app.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-512.png', 'logo-full.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
        return hit || caches.match('index.html');
      });
    })
  );
});

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { /* plain text */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Greenroom', {
    body: d.body || '',
    icon: 'icon-180.png',
    badge: 'icon-180.png',
    data: { tourId: d.tourId || null }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    return clients.openWindow('./');
  }));
});
