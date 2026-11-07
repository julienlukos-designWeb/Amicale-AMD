// A.M.D — service worker minimal : l'application reste installable et s'ouvre même si le réseau est lent.
// Réseau d'abord : les données et mises à jour sont toujours récentes ; le cache ne sert qu'en secours.
// + Notifications : affiche les messages envoyés par les administrateurs, même application fermée.
const CACHE = 'amd-v3';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(r).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); return res;
  }).catch(() => caches.match(r).then(m => m || caches.match('./'))));
});

// ---------- Notifications ----------
// Pastille avec le nombre de notifications sur l'icône A.M.D (là où le téléphone le permet)
async function majPastille() {
  try {
    const n = (await self.registration.getNotifications()).length;
    if (self.navigator.setAppBadge) n ? await self.navigator.setAppBadge(n) : await self.navigator.clearAppBadge();
  } catch (_) {}
}
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const url = new URL(d.url || './', self.registration.scope).href;
  e.waitUntil(self.registration.showNotification(d.title || 'A.M.D', {
    body: d.body || '',
    icon: new URL('icon-192.png', self.registration.scope).href,
    badge: new URL('icon-192.png', self.registration.scope).href,
    tag: d.tag || 'amd',
    renotify: true,              // sonne et vibre à chaque nouveau message
    requireInteraction: true,    // reste affichée jusqu'à ce que le membre la touche
    vibrate: [250, 120, 250, 120, 400],
    data: { url }
  }).then(majPastille));
});
self.addEventListener('notificationclose', e => { e.waitUntil(majPastille()); });

self.addEventListener('notificationclick', e => {
  e.notification.close();
  majPastille();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  const p = new URL(url).searchParams.get('p');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        if (p) c.postMessage({ amdGoto: p });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
