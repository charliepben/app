// L'appli photo d'identite a demenage dans un depot prive. Ce service worker
// remplace l'ancien sur les appareils qui l'avaient installee : il efface la
// copie hors connexion et se desinstalle.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('photo-identite')) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })());
});
