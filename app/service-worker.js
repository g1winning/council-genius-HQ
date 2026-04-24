/* Council Genius PWA — service worker.
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS/logo/manifest) → cache-first, network fallback.
 *   - API calls (/api/*, /c/*) → network-first, no cache. Answers are fresh each time.
 *
 * Cache version is bumped on every deploy via CACHE_NAME.
 */

const CACHE_NAME = 'cg-shell-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './cg_logo.png',
  './privacy.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache API traffic. Always network.
  if (url.pathname.startsWith('/c/') || url.pathname.startsWith('/api/')) {
    return;
  }

  // Cache-first for the app shell.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (!resp || resp.status !== 200 || resp.type !== 'basic') return resp;
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
