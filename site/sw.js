// Binchika service worker (session 142): an offline fallback and nothing else.
// It keeps ONE page, /offline/, with the stylesheets and images that page needs, and shows it only when a page cannot
// be loaded. It never stores or answers /api/ requests, figures, portal data or anything a person typed, and it never
// answers from its store while the network works. Bump VERSION when src/pages/offline.html changes.
const VERSION = "v1";
const CACHE = `binchika-offline-${VERSION}`;
const OFFLINE = "/offline/";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch(new Request(OFFLINE, { cache: "reload" }));
    if (!res.ok) throw new Error("offline page unavailable");
    const html = await res.clone().text();
    await cache.put(OFFLINE, res);
    const assets = [...new Set([...html.matchAll(/(?:href|src)="(\/assets\/[^"]+\.(?:css|png|webp|svg)(?:\?[^"]*)?)"/g)].map((m) => m[1]))];
    await Promise.all(assets.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("binchika-offline-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE)) ?? Response.error()));
    return;
  }
  // The offline page's own styles and images: network first, the stored copy only if the network fails.
  if (url.pathname.startsWith("/assets/") && (req.destination === "style" || req.destination === "image")) {
    event.respondWith(fetch(req).catch(async () => (await caches.match(req)) ?? Response.error()));
  }
});
