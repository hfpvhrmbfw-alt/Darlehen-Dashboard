// Service Worker: alle App-Dateien beim Installieren vorab speichern, danach Cache zuerst.
// Bei jeder Änderung an einer App-Datei VERSION erhöhen, damit die UPDATE-Note erscheint.
const VERSION = '1.0.0';
const PREFIX = 'darlehen-tracker-';
const CACHE = `${PREFIX}${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './calc.js',
  './worker.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './fonts/SourceSerif4-700.woff2',
  './fonts/IBMPlexMono-400.woff2',
  './fonts/IBMPlexMono-500.woff2',
  './fonts/IBMPlexMono-600.woff2',
  './fonts/IBMPlexMono-600-numero.woff2',
  './fonts/IBMPlexSans-400.woff2',
  './fonts/IBMPlexSans-600.woff2',
];

self.addEventListener('install', (event) => {
  // Kein skipWaiting: die neue Version wartet, bis die Nutzerin "Neu laden" wählt.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))
    ))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fremde Adressen gibt es in der App nicht

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      return new Response('Offline und nicht im Zwischenspeicher.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
