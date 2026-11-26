/* SK Guard service worker - cache app shell only.
   ห้าม cache Supabase API แบบถาวร: ข้อมูลล็อก/จุดตรวจต้องสดเสมอ */
const CACHE_NAME = 'sk-guard-v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Supabase API / Auth: network only (ไม่ cache)
  if (url.hostname.includes('supabase.co')) return;
  // CDN libs: network-first, fallback cache
  if (url.hostname.includes('cdn.jsdelivr.net') || url.hostname.includes('unpkg.com') || url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // App shell / same-origin: cache-first, fallback network, offline -> index.html
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => {
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      return new Response('ออฟไลน์', { status: 503, statusText: 'Offline' });
    }))
  );
});
