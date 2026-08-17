/**
 * Offline support.
 *
 * The whole app is a handful of small static files, so it is precached on
 * install and served cache-first afterwards. A padel court is exactly the kind
 * of place with no usable signal, and the scoreboard must not care.
 */

const CACHE = "d10-padel-v1";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./src/app.js",
  "./src/ui.js",
  "./src/match.js",
  "./src/input.js",
  "./src/storage.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // A reload with no network must still open the scoreboard.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("./index.html", { ignoreSearch: true })),
    );
    return;
  }

  // Stale while revalidate: answer from cache so the court has no wait and no
  // network dependency, but refresh in the background so a deployed change
  // lands on the next open. Cache-first alone would pin every phone to
  // whatever shipped first, since this worker only reinstalls when its own
  // bytes change.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit);

      return hit || fresh;
    }),
  );
});
