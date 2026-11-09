/*
 * Rapture Chess service worker: what makes the site installable, and keeps the shell opening offline.
 *
 * Navigations and the Vite bundle go network first (a new deploy shows up on the next launch; the cached copy is the
 * offline fallback). Immutable content (/assets hashed bundles, /models, /art, /draco, /ui, /brand) is served from
 * the cache once seen. Cross-origin requests (RPC, relay, wallet) are never touched.
 */
const VERSION = 'rapture-chess-v1';
const SHELL = ['/', '/manifest.webmanifest', '/brand/emblem.webp', '/brand/rapture-chess.2.webp', '/brand/gods-vs-titans.webp'];
const IMMUTABLE = /^\/(assets|models|art|draco|ui|brand)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // every page is the one shell: the match launch query is kept, the cached '/' answers offline
    event.respondWith(fetch(req).then((res) => { put('/', res.clone()); return res; }).catch(() => caches.match('/')));
    return;
  }
  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => { put(req, res.clone()); return res; })));
    return;
  }
  event.respondWith(fetch(req).then((res) => { put(req, res.clone()); return res; }).catch(() => caches.match(req)));
});

function put(key, res) {
  if (!res || !res.ok || res.type !== 'basic') return;
  caches.open(VERSION).then((cache) => cache.put(key, res)).catch(() => {});
}
