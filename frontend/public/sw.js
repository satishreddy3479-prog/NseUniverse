/* NSE Universe service worker.
 * Caches only the static app shell (built files) so the app opens fast and installs.
 * Market data is NEVER cached or replayed: /api and /ws always go to the network. */
const CACHE = "nse-universe-shell-v2"; // v2: old caches (which could hold an index page stored under a script name) are dropped on activate
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.add("/"))); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) return; // live data: network only
  if (req.mode === "navigate") { // always try the server first so a new deploy shows up; fall back to the cached shell
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); return r; }).catch(() => caches.match("/")));
    return;
  }
  if (url.pathname.startsWith("/assets/")) { // hashed build files never change: cache first
    // Only a real file is stored: a missing name can come back as the index page or an error, and keeping that would break the page for good.
    const real = (r) => r.ok && !(r.headers.get("content-type") || "").includes("text/html");
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (real(r)) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; })));
  }
});
