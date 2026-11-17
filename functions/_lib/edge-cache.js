// Short shared cache for a public read route: one copy per Cloudflare data centre, through the Cache API.
// To change the lifetime, change RESULTS_CACHE_SECONDS only; docs/tally-streaming-research.md explains the limits.
export const RESULTS_CACHE_SECONDS = 15;

/** build() returns { response, store }. A cache fault never fails a request, and only an OK response marked store is kept. */
export async function readThroughCache({ key, waitUntil, build }) {
  const cache = globalThis.caches?.default;
  let hit = null;
  try { hit = cache ? await cache.match(key) : null; } catch { /* Serve from the source. */ }
  if (hit) {
    const served = new Response(hit.body, hit);
    served.headers.set("x-binchika-cache", "hit");
    // Without this a browser could keep a hit for a full max-age more, on top of its time in this cache.
    served.headers.set("age", String(Math.max(0, Math.floor((Date.now() - Number(hit.headers.get("x-binchika-built"))) / 1000))));
    return served;
  }
  const { response, store } = await build();
  response.headers.set("x-binchika-cache", "miss");
  response.headers.set("x-binchika-built", String(Date.now()));
  if (cache && store && response.ok) {
    try {
      const put = cache.put(key, response.clone()).catch(() => {});
      if (waitUntil) waitUntil(put); else await put;
    } catch { /* The response is still good. */ }
  }
  return response;
}
