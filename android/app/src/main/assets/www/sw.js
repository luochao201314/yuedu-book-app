// 离线缓存（仅 PWA / 浏览器托管时生效；APK 用本地资源，不依赖此 SW）
const CACHE = 'yuedu-v1';
const ASSETS = ['index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request)
      .then(resp => { const cp = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return resp; })
      .catch(() => r))
  );
});
