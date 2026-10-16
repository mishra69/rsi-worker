// RSI Tracker service worker. Based on the pwa-cloudflare skill's template.
//
// deploy.sh stamps VERSION, which changes this file's bytes — that's what makes a
// new worker install, and it names the cache so every deploy busts it.
const VERSION = '20261016_2132';
const CACHE = 'rsi-' + VERSION;

// Same suffix the HTML carries, so the precached URL and the requested one match.
const V = '?v=' + VERSION;

const SHELL = [
  // '/' only, never '/index.html': Workers Static Assets 307-redirects
  // /index.html to /, and the Cache API refuses to store a redirected response.
  '/',
  '/css/styles.css' + V,
  '/js/config.js' + V,
  '/js/version-check.js' + V,
  '/js/pwa-install.js' + V,
  '/js/app.js' + V,
  // Unversioned: client.js imports './sw.js' relatively and that inner request
  // can't carry a version, so neither does the outer one. They change only when
  // the package does.
  '/js/vendor/webpush-edge/client.js',
  '/js/vendor/webpush-edge/sw.js',
  // Unversioned: fetched by the browser, not the page; content-stable.
  '/manifest.json',
  '/fonts/inter-latin.woff2',
  '/fonts/jetbrains-mono-latin.woff2',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // Each file independently: with addAll() one 404 silently kills offline support.
      .then(c => Promise.all(SHELL.map(url => c.add(url).catch(err => {
        console.warn('[sw] failed to precache', url, err);
      }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Push ──────────────────────────────────────────────────────────────────────
// Mirrors webpush-edge's createPushHandler, inlined because this worker is a
// classic script. A push handler is required: Declarative Web Push alone doesn't
// display on iOS.

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }
  // The payload arrives wrapped as { web_push: 8030, notification: {...} }.
  // Reading the top level would show the app name, an empty body, and open '/'.
  const n = data.notification || data;
  e.waitUntil(self.registration.showNotification(n.title || 'RSI Tracker', {
    body: n.body || '',
    icon: n.icon || '/icons/icon-192.png',
    badge: n.badge || '/icons/icon-192.png',
    tag: n.tag || 'rsi-alert',
    data: { url: n.navigate || n.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === location.origin && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});

// Push services rotate endpoints; without this, notifications silently stop.
// The worker holds no session token, so this posts to a public route authorised
// by possession of the old endpoint.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const oldEndpoint = e.oldSubscription?.endpoint;
    if (!oldEndpoint) return; // nothing to prove ownership with; the page re-subscribes on next open
    try {
      const { key } = await fetch('/api/push/key').then(r => r.json());
      if (!key) return;
      const fresh = e.newSubscription || await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
      await fetch('/api/push/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_endpoint: oldEndpoint, subscription: fresh.toJSON() }),
      });
    } catch (err) {
      console.warn('[sw] resubscribe failed', err);
    }
  })());
});

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Never touch the cache for non-GET or cross-origin requests (Google sign-in,
  // the avatar image).
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  // Network-only for the API, with a JSON error the page can parse offline.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    return;
  }

  // Network-first for navigations so a deploy lands on next launch; cached shell offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok && !res.redirected) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put('/', clone));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Version probes (?_v=) must reach the network, or a stale build can never notice.
  if (url.searchParams.has('_v')) {
    e.respondWith(fetch(request));
    return;
  }

  // Cache-first for static assets, refreshing in the background.
  e.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      }).catch(err => {
        if (cached) return cached;
        throw err;
      });
      return cached || network;
    })
  );
});
