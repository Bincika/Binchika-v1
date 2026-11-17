// GET /api/news — election headlines from established Exampleland/African outlets (headline + link only).
// Fetched at the edge and cached for 10 minutes; a dead feed never breaks the others.
import { parseFeed, electionOnly, mergeLatest } from "../_lib/rss.js";
import { TENANT } from "../_lib/tenant.generated.js";

const FEEDS = TENANT.news.feeds;
const TTL = 600;

export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default;
  const key = new Request(new URL("/api/news?v=1", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const results = await Promise.allSettled(FEEDS.map(async ([name, url]) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "BinchikaNewsReel/1.0 (+https://binchika.com/about/)", Accept: "application/rss+xml, application/xml, text/xml" }, cf: { cacheTtl: TTL } });
      if (!r.ok) throw new Error(String(r.status));
      return electionOnly(parseFeed(await r.text(), name));
    } finally { clearTimeout(t); }
  }));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const body = {
    items: mergeLatest(ok, 24),
    sources: FEEDS.map(([name], i) => ({ name, ok: results[i].status === "fulfilled" })),
    fetchedAt: new Date().toISOString(),
  };
  const res = new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${TTL}` } });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
