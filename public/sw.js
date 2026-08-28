/**
 * Service Worker de BaeCount.
 *
 * No intercepta peticiones a propósito. Antes había un handler de `fetch` que hacía
 * `e.respondWith(fetch(e.request))`: no aportaba nada (es lo que el navegador ya hace),
 * pero sí quitaba de en medio su gestión nativa de rangos, redirecciones y errores de red.
 *
 * Tampoco se cachea nada: la app muestra cifras que se editan a mano en Google Sheets y
 * servir una copia guardada haría que se vieran datos que ya no son ciertos.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Limpiar cachés de versiones anteriores del service worker
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});
