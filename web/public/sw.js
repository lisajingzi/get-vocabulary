/* eslint-disable */
/**
 * Service worker for GET! — minimal offline support.
 *
 * Strategy:
 *   - Pre-cache nothing on install (Next.js builds hashed asset names; we don't
 *     know them at SW install time and don't want to fight that).
 *   - Runtime cache:
 *       * /dict/*.json       → cache-first, immutable. These are the bulk of
 *                              the offline experience and never change at
 *                              runtime (they're rebuilt only when we re-run
 *                              parse_mdx.py and ship a new dict-version).
 *       * /_next/static/*    → cache-first. Hashed filenames make this safe.
 *       * HTML navigations    → network-first. Avoids the "stale HTML points at
 *                              a chunk hash that no longer exists" white-screen
 *                              after a fresh deploy (esp. in WeChat WebView).
 *                              Falls back to cache when offline.
 *       * Everything else GET → stale-while-revalidate so the app shell loads
 *                              offline once it's been visited online once.
 *   - POST / API calls are passed through untouched. The AI routes need a
 *     network anyway; failing gracefully there is the route handler's job.
 *
 * No Workbox dependency on purpose — this is < 80 lines and has zero runtime
 * upgrades to worry about.
 */

const VERSION = "v2";
const RUNTIME = `get-runtime-${VERSION}`;
const DICT = `get-dict-${VERSION}`;
const STATIC = `get-static-${VERSION}`;
const HTML = `get-html-${VERSION}`;

self.addEventListener("install", (event) => {
  // Activate immediately on first install.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any caches from older versions.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.endsWith(VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only handle same-origin requests; we don't want to cache DeepSeek calls
  // (and they're CORS-sensitive anyway).
  if (url.origin !== self.location.origin) return;

  // 1) Dictionary shards — cache-first, content is immutable.
  if (url.pathname.startsWith("/dict/")) {
    event.respondWith(cacheFirst(req, DICT));
    return;
  }
  // 2) Hashed static assets.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(req, STATIC));
    return;
  }
  // 3) API routes — never cache, just network.
  if (url.pathname.startsWith("/api/")) return;

  // 4) HTML navigations — network-first. Prevents stale HTML from referencing
  //    chunk hashes that no longer exist on the server (classic WeChat WebView
  //    white-screen after a fresh Vercel deploy). Falls back to cache when
  //    offline so the app shell still opens.
  const isHTML =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");
  if (isHTML) {
    event.respondWith(networkFirst(req, HTML));
    return;
  }

  // 5) Default: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(req, RUNTIME));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    // Last-ditch: empty response so the caller can fail cleanly offline.
    return new Response("", { status: 504, statusText: "offline" });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || fetchPromise;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // Nothing cached and no network — return a minimal offline page.
    return new Response(
      "<!doctype html><meta charset=utf-8><title>offline</title><p>offline",
      { status: 504, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}
