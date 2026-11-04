// Profile Finder service worker: makes the dashboard installable and quick to open.
// Only this site's own files are cached. Requests to Supabase (sign-in and data)
// are never intercepted or stored.
const VERSION = "pf-v2";
const SHELL = [
  "./", "index.html", "help.html", "app.js", "config.js", "styles.css", "manifest.webmanifest",
  "fonts/geist-latin.woff2", "fonts/geist-mono-latin.woff2",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon.svg",
];
const STATIC = /\/(fonts|icons|guide)\//;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Fonts, icons and guide images rarely change: serve from cache first.
  if (STATIC.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(response => {
        if (response.ok) { const copy = response.clone(); caches.open(VERSION).then(cache => cache.put(request, copy)); }
        return response;
      }))
    );
    return;
  }

  // Pages, code and styles: always try the network first so updates appear
  // straight away; fall back to the saved copy when offline.
  event.respondWith(
    fetch(request).then(response => {
      if (response.ok && !url.search) { const copy = response.clone(); caches.open(VERSION).then(cache => cache.put(request, copy)); }
      return response;
    }).catch(() => caches.match(request, {ignoreSearch: true})
      .then(hit => hit || (request.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
