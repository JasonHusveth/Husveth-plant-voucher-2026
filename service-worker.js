// MN Vascular Plant Voucher — Service Worker
// Caches all app files for full offline use
// Update CACHE_VERSION whenever you push a new version of the app

const CACHE_VERSION = 'voucher-v3';
const CACHE_NAME = CACHE_VERSION;

// All files to cache on install
const FILES_TO_CACHE = [
  './',
  './index.html',
  './herbarium_voucher_app_v2.html',
  './herbarium_label_generator.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// ── Install: cache all app files ──────────────────────────────
self.addEventListener('install', function(event) {
  console.log('[SW] Installing cache:', CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('[SW] Caching app files');
      // Cache each file individually so one failure doesn't break everything
      return Promise.allSettled(
        FILES_TO_CACHE.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('[SW] Failed to cache:', url, err);
          });
        })
      );
    }).then(function() {
      // Force this service worker to activate immediately
      return self.skipWaiting();
    })
  );
});

// ── Activate: clean up old caches ────────────────────────────
self.addEventListener('activate', function(event) {
  console.log('[SW] Activating:', CACHE_NAME);
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(name) {
          if (name !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(function() {
      // Take control of all open pages immediately
      return self.clients.claim();
    })
  );
});

// ── Fetch: serve from cache, fall back to network ────────────
self.addEventListener('fetch', function(event) {
  const url = new URL(event.request.url);

  // Never intercept POST requests — let export to Sheets go direct
  if (event.request.method === 'POST') {
    return;
  }

  // Never cache Google Apps Script calls
  if (url.hostname.includes('script.google.com')) {
    return;
  }

  // For everything else: cache-first strategy
  // Serve from cache instantly, then check network for updates in background
  event.respondWith(
    caches.match(event.request).then(function(cachedResponse) {
      if (cachedResponse) {
        // Serve cached version immediately
        // In background, fetch fresh version and update cache
        const fetchPromise = fetch(event.request).then(function(networkResponse) {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, networkResponse.clone());
            });
          }
          return networkResponse;
        }).catch(function() {
          // Network failed — cached version already served, no problem
        });
        return cachedResponse;
      }

      // Not in cache — try network
      return fetch(event.request).then(function(networkResponse) {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }
        // Cache this new resource for next time
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      }).catch(function(err) {
        console.warn('[SW] Fetch failed for:', event.request.url, err);
        // Could return a custom offline page here if desired
      });
    })
  );
});
