const CACHE = 'photo-identite-v4';
const CACHE_MODELES = 'photo-identite-modeles-v1';   // garde entre deux versions de l'appli
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './photo.js',
  './manifest.json',
  './icon.svg',
  './vendor/vision_bundle.mjs',
  './vendor/background-removal.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== CACHE_MODELES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Modeles et wasm (CDN, URL versionnees, ~100 Mo) : cache d'abord, jamais
  // retelecharges en arriere-plan.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        if (response.ok) {
          const copie = response.clone();
          caches.open(CACHE_MODELES).then((cache) => cache.put(event.request, copie));
        }
        return response;
      }))
    );
    return;
  }

  // L'appli elle-meme : cache tout de suite, mise a jour en arriere-plan.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copie = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copie));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
