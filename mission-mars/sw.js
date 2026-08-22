const CACHE_NAME = "mission-mars-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./simulateur.html",
  "./manifest.json",
  "./icons/favicon.svg",
  "./icons/favicon-simulateur.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  // Visuels des missions : legers, et indispensables a l'identite de chaque jeu
  "./img/mode-cristal-rush.png",
  "./img/mode-fire.png",
  "./img/mode-duel-orbital.png",
  // Sons pre-charges : le jour de la fete le telephone peut tres bien
  // etre hors-ligne, et un jeu muet serait raté.
  "./sounds/crystal.ogg",
  "./sounds/crystal-break.ogg",
  "./sounds/explosion.ogg",
  "./sounds/flame.ogg",
  "./sounds/beep.ogg",
  "./sounds/beep-final.ogg",
  "./sounds/liftoff.ogg",
  "./sounds/success.ogg",
  "./sounds/fail.ogg",
  "./sounds/siren.ogg",
  // Voix de l'annonceur du décompte (Duel orbital)
  "./sounds/voice-5.ogg",
  "./sounds/voice-4.ogg",
  "./sounds/voice-3.ogg",
  "./sounds/voice-2.ogg",
  "./sounds/voice-1.ogg",
  "./sounds/voice-go.ogg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map((u) => cache.add(u).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Réseau d'abord (pour toujours avoir la dernière version en ligne),
// on ne retombe sur le cache que si le téléphone est hors-ligne.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
