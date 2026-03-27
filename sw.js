/**
 * SABUN PWA — Service Worker
 * ライブラリとHTMLをキャッシュしてオフライン動作を実現
 */
const CACHE_NAME = 'sabun-v1';
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './lib/pdf.mjs',
  './lib/pdf.worker.mjs',
  './lib/pixelmatch-browser.js',
  './lib/diff_match_patch.js',
  './manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // PDF ファイルはキャッシュしない
  if (event.request.url.endsWith('.pdf')) return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
