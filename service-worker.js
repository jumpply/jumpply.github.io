const CACHE = 'jp-v1';

const PRECACHE = [
  './',
  './index.html',
  './src/main.js',
  './src/styles.css',
  './manifest.json',
  // CDN resources are cached on first fetch (see fetch handler)
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (ev) => {
  const { request } = ev;
  const url = new URL(request.url);

  // Never intercept SSE or action requests to the ESP32
  if (!url.host.includes(self.location.host)) {
    return; // let the browser handle cross-origin requests natively
  }

  ev.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
