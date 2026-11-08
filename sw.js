// Network-first so a new deploy shows up immediately; the cache only serves offline launches.
// The deploy workflow replaces __V__ with the commit, so every deploy is a new worker with its
// own cache, and index.html asks for exactly the style.css / app.js / objects.js it was built
// with. A fresh page can then never run with a stale script left in some cache.
const V = '__V__';
const CACHE = `simple-image-editor-${V}`;
const ASSETS = [
  './',
  `style.css?v=${V}`,
  `js/app.js?v=${V}`,
  `js/objects.js?v=${V}`,
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Navigation requests cannot be re-created with options, and are revalidated anyway.
  const fresh = req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' });
  e.respondWith(
    fresh
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' })),
  );
});
