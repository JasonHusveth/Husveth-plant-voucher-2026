// Clean-up worker (2026-11-25). The NPC Field Key was uploaded to this repo by mistake for a few hours and its
// service worker (sw.js) may still be installed on devices that opened the voucher app in that window.
// This version removes the NPC caches, unregisters itself and reloads the page so the voucher app
// (and its own service-worker.js) takes over again.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('npc-key')) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
