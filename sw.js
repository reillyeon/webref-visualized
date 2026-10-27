/* Webref Visualized — service worker.
 *
 * Caches the webref crawl data (JSON) so repeat visits load instantly, even
 * offline. Strategy:
 *
 *   - normal requests  → cache first, falling back to the network (and
 *                        storing the result);
 *   - cache: "reload"  → network first (bypassing the HTTP cache), storing
 *                        the result; the page uses this to revalidate in the
 *                        background after it has finished loading;
 *   - message {type: "purge", keep: [...]} → drop every cached entry except
 *                        the given URLs; the page sends this when the crawl
 *                        date in index.json has changed.
 *
 * Only JSON data is cached here; the app shell (HTML/JS/CSS) is left to the
 * normal HTTP cache so code changes show up immediately.
 */

const CACHE = "webref-data-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("webref-data-") && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

function isDataRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  return url.pathname.endsWith(".json");
}

function tagged(response, source) {
  // Mark where the response came from so the page can report it.
  const headers = new Headers(response.headers);
  headers.set("X-Webref-Source", source);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!isDataRequest(request)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const revalidating = request.cache === "reload" || request.cache === "no-store";

    if (!revalidating) {
      const hit = await cache.match(request.url);
      if (hit) return tagged(hit, "cache");
    }

    try {
      const response = await fetch(request);
      if (response.ok) event.waitUntil(cache.put(request.url, response.clone()));
      return tagged(response, "network");
    } catch (err) {
      // Offline while revalidating: fall back to whatever we have.
      const hit = await cache.match(request.url);
      if (hit) return tagged(hit, "cache-offline");
      throw err;
    }
  })());
});

self.addEventListener("message", (event) => {
  const { type, keep = [], id } = event.data || {};
  if (type !== "purge") return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const keepSet = new Set(keep);
    let removed = 0;
    for (const req of await cache.keys()) {
      if (!keepSet.has(req.url)) { await cache.delete(req); removed++; }
    }
    event.source?.postMessage({ type: "purged", id, removed });
  })());
});
