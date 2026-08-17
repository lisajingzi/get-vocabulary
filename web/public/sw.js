/* eslint-disable */
/**
 * Self-destructing Service Worker.
 *
 * Historical context: earlier versions of this file implemented a
 * stale-while-revalidate cache for HTML plus a cache-first strategy for
 * /_next/static/*. That combination is *unsafe* on a Vercel deployment:
 *   - Vercel gives every deploy a fresh set of hashed JS chunk filenames.
 *   - When we deploy a new version, the SW would happily serve the *old*
 *     HTML shell (SWR is stale-first), and that old HTML references chunk
 *     filenames that no longer exist on Vercel — resulting in a white
 *     screen, especially inside iOS Safari and the WeChat WebView where
 *     users cannot easily clear caches.
 *
 * We are stepping away from a custom SW entirely. Vercel already sets
 * `Cache-Control: public, max-age=31536000, immutable` on /_next/static/*
 * and revalidates HTML through ETag, so the browser's built-in HTTP cache
 * gives us everything we actually need — without any of the "serve stale
 * HTML that points at deleted JS" failure mode.
 *
 * This file's *only* job now is to clean up after previously-installed
 * versions of the SW so returning users self-heal on the next visit.
 * layout.tsx no longer registers a new SW, but the browser will still
 * fetch this file for any client that already has an old registration
 * (browsers poll /sw.js roughly every 24h, or on navigation). Once this
 * SW activates it wipes every cache, unregisters itself, and asks all
 * open pages to reload — so the *next* page load is served entirely from
 * the network with no SW in the way.
 */

self.addEventListener("install", (event) => {
  // Take over as fast as possible so we can start cleaning up.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 1) Wipe every CacheStorage bucket we (or any prior version of
      //    this SW) ever created. We don't filter by name on purpose —
      //    if this SW is running, none of the caches are trusted.
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {
        // Ignore — we still want to unregister below.
      }

      // 2) Unregister ourselves so future navigations bypass the SW
      //    entirely and go straight to the network + HTTP cache.
      try {
        await self.registration.unregister();
      } catch (_) {}

      // 3) Force every currently-open tab/window to reload so it picks
      //    up the current HTML from the network instead of continuing
      //    to run against the now-orphaned SW context.
      try {
        const clientsList = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of clientsList) {
          // navigate() is preferable to postMessage because it doesn't
          // require the page to have listener code — which older cached
          // HTML shells obviously wouldn't have.
          try {
            await client.navigate(client.url);
          } catch (_) {
            // Fallback: just tell the page to reload if navigate fails
            // (e.g. cross-origin edge cases).
            client.postMessage({ type: "SW_KILLED_RELOAD" });
          }
        }
      } catch (_) {}
    })(),
  );
});

// Deliberately no `fetch` listener: with no fetch handler installed the
// browser bypasses this SW for network requests, which is exactly what
// we want during the brief window between activation and unregister
// completing.
