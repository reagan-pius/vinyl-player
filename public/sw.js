/* Vinyl Player service worker — network-first app shell, cache fallback. */
const CACHE = 'vinyl-player-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response && response.status === 200 && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        const hit = await cache.match(request);
        if (hit) return hit;
        if (request.mode === 'navigate') {
          const shell = await cache.match('/index.html');
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })(),
  );
});
