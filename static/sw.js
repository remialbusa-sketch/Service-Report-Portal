/**
 * Service Worker — Service Report Portal
 * Strategy:
 *   - Static assets (JS/CSS/images):  CacheFirst
 *   - Navigation (HTML pages):        NetworkFirst → fallback to cache
 *   - API / submit / uploads:         NetworkOnly  (never cached)
 */

const CACHE_NAME = "service-report-v2";

const PRECACHE_URLS = [
  "/",
  "/static/dist/main.js",
  "/static/dist/main.css",
  "/static/MCBIO-Logo.png",
];

// ── Install: pre-cache app shell ─────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

// ── Activate: purge old caches ───────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ── Fetch: routing logic ─────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Never intercept non-GET or cross-origin requests
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // 2. NetworkOnly for API, form submission, signature upload, auth routes
  const networkOnlyPaths = [
    "/submit",
    "/api/",
    "/search_linked_items",
    "/auth/",
    "/admin/",
  ];
  if (networkOnlyPaths.some((p) => url.pathname.startsWith(p))) {
    return;
  }

  // 3. CacheFirst for fingerprinted static assets (JS/CSS/fonts/images)
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
            return res;
          }),
      ),
    );
    return;
  }

  // 4. NetworkFirst for navigation (HTML pages) — fresh when possible,
  //    fall back to cached version so the form loads offline
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          return res;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("/")),
        ),
    );
    return;
  }
});
