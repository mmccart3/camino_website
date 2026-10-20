/* Saint Jean to Santiago service worker.
 *
 * Served by Django at /sw.js, which fills in the two placeholders below:
 *   __VERSION__   the APP_VERSION of this release
 *   __PRECACHE__  the list of core files to save when the worker installs
 * Changing APP_VERSION changes this file, so browsers install the new worker,
 * show an "update available" prompt, and the old caches are deleted.
 */
const VERSION = '__VERSION__';
const PRECACHE_URLS = __PRECACHE__;

const CACHE_STATIC = 'camino-static-' + VERSION;
const CACHE_PAGES = 'camino-pages-' + VERSION;
const CACHE_PACK = 'camino-pack';      // pages saved by "Save for offline"; kept across versions
const CACHE_IMAGES = 'camino-images';  // photos and maps seen while browsing
const CACHE_TILES = 'camino-tiles';    // map tiles seen while browsing (never bulk-downloaded)
const KEEP_CACHES = [CACHE_STATIC, CACHE_PAGES, CACHE_PACK, CACHE_IMAGES, CACHE_TILES];

const OFFLINE_URL = '/offline/';
const NETWORK_TIMEOUT_MS = 4000;  // on a weak signal, fall back to the saved page after this long
const MAX_IMAGES = 80;
const MAX_TILES = 400;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) =>
      Promise.allSettled(PRECACHE_URLS.map((url) => precache(cache, url)))
    )
  );
  // No skipWaiting() here: the page offers the update and sends SKIP_WAITING.
});

async function precache(cache, url) {
  const sameOrigin = new URL(url, self.location.origin).origin === self.location.origin;
  const request = new Request(url, { mode: sameOrigin ? 'same-origin' : 'cors', credentials: 'omit' });
  const response = await fetch(request);
  if (response.ok) await cache.put(url, response);
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !KEEP_CACHES.includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    const path = url.pathname;
    // Never keep anything from the data editor, the admin, or the worker itself.
    if (path === '/sw.js' || path.startsWith('/editor/') || path.startsWith('/admin/') || path === '/offline-pack.json') return;
    if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
      event.respondWith(networkFirstPage(event, request));
    } else if (path.startsWith('/static/')) {
      event.respondWith(cacheFirst(request, CACHE_STATIC));
    }
    return;
  }

  if (url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
  } else if (isMapTile(url)) {
    event.respondWith(staleWhileRevalidate(event, request, CACHE_TILES, MAX_TILES));
  } else if (request.destination === 'image') {
    event.respondWith(staleWhileRevalidate(event, request, CACHE_IMAGES, MAX_IMAGES));
  }
});

function isMapTile(url) {
  return url.hostname.endsWith('arcgisonline.com') || url.hostname.endsWith('tile.openstreetmap.org');
}

/* Pages: try the network first so prices and opening times are current. If it is slow or
   absent, use the saved copy (offline pack first, then pages already visited). */
function networkFirstPage(event, request) {
  const network = fetch(request).then((response) => {
    if (response.ok && !response.redirected && response.type === 'basic') {
      event.waitUntil(storePage(request.url, response.clone()));
    }
    return response;
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));

  return Promise.race([network.catch(() => null), timeout]).then(async (response) => {
    if (response && response.status < 500) return response;
    const saved = await findSavedPage(request.url);
    if (saved) return saved;
    if (response) return response;
    try {
      return await network;  // nothing saved: keep waiting for the slow network
    } catch (error) {
      return (await caches.match(OFFLINE_URL)) || Response.error();
    }
  });
}

async function storePage(url, response) {
  const pages = await caches.open(CACHE_PAGES);
  await pages.put(url, response.clone());
  const pack = await caches.open(CACHE_PACK);
  if (await pack.match(url)) await pack.put(url, response.clone());  // keep the offline pack fresh
}

async function findSavedPage(url) {
  const path = new URL(url).pathname;
  const lookups = [CACHE_PACK, CACHE_PAGES];
  for (const name of lookups) {
    const cache = await caches.open(name);
    const exact = await cache.match(url);
    if (exact) return exact;
    if (path !== '/search/') {
      const loose = await cache.match(url, { ignoreSearch: true });
      if (loose) return loose;
    }
  }
  return null;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

/* Images and tiles: show the saved copy straight away and refresh it in the background.
   Cross-origin images are fetched with CORS so they are stored as real (not opaque) responses. */
async function staleWhileRevalidate(event, request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = (await cache.match(request)) || (await caches.match(request));  // also finds offline-pack images
  const refresh = fetchForCache(request).then(async (response) => {
    if (response && (response.ok || response.type === 'opaque')) {
      await cache.put(request.url, response.clone());
      event.waitUntil(trimCache(cache, maxEntries));
    }
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => null));
    return cached;
  }
  return refresh;
}

async function fetchForCache(request) {
  if (new URL(request.url).origin !== self.location.origin) {
    try {
      return await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    } catch (error) {
      // The host does not allow CORS: fall back to the page's own (opaque) request.
    }
  }
  return fetch(request);
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i += 1) await cache.delete(keys[i]);
}
