// Cache only the public shell, never API responses, credentials or transcripts.
const CACHE = 'orchestrator-shell-v1';
const ASSETS = ['/', '/app.js', '/voice.js', '/cluster-client.js', '/styles.css'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    for (const asset of ASSETS) {
      const response = await fetch(asset);
      if (response.ok) await cache.put(asset, response);
    }
    await self.skipWaiting();
  }));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  const asset = url.pathname === '/index.html' ? '/' : url.pathname;
  if (!ASSETS.includes(asset)) return;
  event.respondWith(fetch(event.request, { signal: AbortSignal.timeout(3000) }).then(async (response) => {
    if (response.ok) { const cache = await caches.open(CACHE); await cache.put(asset, response.clone()); }
    return response;
  }).catch(() => caches.match(asset)));
});
