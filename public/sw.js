/**
 * An offline shell, and nothing more.
 *
 * The game itself needs the network — there is no offline mode for a room — so
 * this only caches the files that make the app open and look like an app. API
 * calls and the WebSocket are never touched.
 */

const CACHE = 'vauvapeli-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  // Network first, so a deployed change reaches a phone that is online, and the
  // cached shell only steps in when the network does not answer.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      // Written without `??` on purpose: this file is served as-is and never
      // compiled, and an old phone's service worker parser would reject it.
      .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html'))),
  );
});
