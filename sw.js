// Network-first so a new deploy shows up immediately; the cache only serves offline launches.
// Every request revalidates with the server: the browser's HTTP cache (10 min on GitHub Pages)
// could otherwise pair a fresh index.html with a stale app.js and break startup.
const CACHE = 'screenshot-editor-v2';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'js/app.js',
  'js/objects.js',
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
      .catch(() => caches.match(req)),
  );
});
