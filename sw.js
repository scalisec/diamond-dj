/* Offline copy of the app. (Songs and announcements live in IndexedDB, not here.)
   - Each release is saved whole (VERSION). A new copy is downloaded and checked before it's used:
     a missing file, a redirect or the wrong kind of file (a ballpark wifi sign-in page answering
     instead of GitHub) skips the update and the current version keeps working.
   - The app always opens from the saved copy, so weak wifi can't hold it up.
   Bump VERSION whenever app files change. */
const VERSION = 'diamond-v8';
const SHELL = ['./', 'index.html', 'app.css', 'version.js', 'manifest.webmanifest',
  'js/model.js', 'js/store.js', 'js/audio.js', 'js/drive.js', 'js/app.js',
  'icons/logo.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-500-normal.woff2', 'fonts/barlow-latin-600-normal.woff2',
  'fonts/barlow-latin-700-normal.woff2', 'fonts/barlow-condensed-latin-600-normal.woff2', 'fonts/barlow-condensed-latin-700-normal.woff2'];
const HOME = new URL('./', self.location).href;
const TYPES = { html: 'text/html', js: 'javascript', css: 'text/css', webmanifest: 'json', png: 'image/png', woff2: 'font' };

async function fetchChecked(path) {
  const url = new URL(path, self.location).href;
  const res = await fetch(url, { cache: 'reload' });
  const ext = url.endsWith('/') ? 'html' : url.split('?')[0].split('.').pop();
  const type = res.headers.get('content-type') || '';
  if (!res.ok || res.redirected || res.type !== 'basic') throw new Error('bad response: ' + url);
  if (TYPES[ext] && !type.includes(TYPES[ext])) throw new Error('unexpected type for ' + url + ': ' + type);
  if (ext === 'html' && !(await res.clone().text()).includes('js/app.js')) throw new Error('not the app page: ' + url);
  return res;
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const files = await Promise.all(SHELL.map(async p => [new URL(p, self.location).href, await fetchChecked(p)]));
    const cache = await caches.open(VERSION);
    await Promise.all(files.map(([url, res]) => cache.put(url, res)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('diamond-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

const timeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(HOME)) return;
  e.respondWith((async () => {
    const key = req.mode === 'navigate' ? HOME : url.href.split('#')[0];
    const saved = await caches.match(key, { ignoreSearch: true, cacheName: VERSION }) || await caches.match(key, { ignoreSearch: true });
    if (saved) return saved;
    try { return await timeout(fetch(req), 8000); }
    catch (err) { return Response.error(); }
  })());
});
