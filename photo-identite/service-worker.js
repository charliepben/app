const CACHE = 'photo-identite-v13';
const CACHE_MODELES = 'photo-identite-modeles-v1';   // garde entre deux versions de l'appli
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './photo.js',
  './album.js',
  './detourage.js',
  './manifest.json',
  './icon.svg',
  './vendor/vision_bundle.mjs',
  './vendor/background-removal.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
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

  // L'appli elle-meme : reseau d'abord, pour toujours ouvrir la derniere
  // version ('no-cache' : le navigateur revalide aupres du serveur au lieu de
  // reprendre sa copie de moins de 10 min). Sans reseau (ou s'il traine plus
  // de 4 s), la copie en cache : l'appli marche hors connexion.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const reseau = fetch(event.request, { cache: 'no-cache' }).then((response) => {
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    });
    const enCache = await cache.match(event.request);
    if (!enCache) return reseau;
    const delai = new Promise((ok) => setTimeout(() => ok(null), 4000));
    try {
      return (await Promise.race([reseau, delai])) || enCache;
    } catch {
      return enCache;
    }
  })());
});
