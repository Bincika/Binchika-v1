// GET /api/press/snapshot?race=president — one read-only document for press desks and civic groups (session 88;
// docs/PRESS-FEED-DESIGN.md). Built only from what /api/results and /api/ledger already publish: totals by state,
// unit counts by confidence, the ledger head and the IReV comparison counts. No photographs, captions, report rows,
// hashes of reporters, verifier IDs, contact text or projections. GET only; no key in the URL.
// Flood resistance: the response is cached at the edge for 15 s per race (caches.default), so repeated calls do not
// reach the database; an optional Cloudflare rate-limit rule is described in docs/PRESS-FEED-DESIGN.md.
import { aggregate, eligibleStateForRace, stateOfPu } from "../../_lib/results.js";
import { TENANT } from "../../_lib/tenant.generated.js";

const RACES = new Set(["president", "senate", "house", "governor", "state-assembly"]);
export const PRESS_NOTICE = TENANT.notice;   // tenants/<id>/tenant.json (session 98)

/** The snapshot body from unit rows and the ledger head. Pure; exported for tests. */
export function buildSnapshot(race, units, head, now = new Date()) {
  const high = units.filter((u) => u.status === "high" && u.tally && eligibleStateForRace(race, stateOfPu(u.pu_code)));
  const agg = aggregate(high.map((u) => ({ pu_code: u.pu_code, tally: u.tally })));
  const count = (s) => units.filter((u) => u.status === s).length;
  return {
    notice: PRESS_NOTICE,
    race,
    updatedAt: now.toISOString(),
    ledger: { head: head?.hash ?? null, count: head?.seq ?? 0, verify: "https://binchika.com/ledger/" },
    units: { published: high.length, lowerConfidence: count("lower"), held: count("held"), notYetHigh: units.length - high.length - count("lower") - count("held"), denominator: 176846, denominatorSource: "INEC 2023 polling units" },
    national: { totals: agg.national },
    byState: Object.fromEntries(Object.entries(agg.byState).map(([iso, s]) => [iso, { units: s.units, totals: s.totals }])),
    irev: { compared: high.filter((u) => u.irev).length, mismatches: high.filter((u) => u.irev && u.irev.match === false).length },
    rules: "Lower-confidence and held units are not in the totals. Local Government results are absent until a SIEC publishes a feed.",
  };
}

export async function onRequestGet({ request, env, waitUntil }) {
  const race = new URL(request.url).searchParams.get("race") ?? "president";
  if (!RACES.has(race)) return Response.json({ error: "unknown race" }, { status: 400 });
  const cacheKey = new Request(`https://binchika.com/api/press/snapshot?race=${race}`);
  const cache = globalThis.caches?.default;
  const hit = cache ? await cache.match(cacheKey) : null;
  if (hit) return hit;
  let units = [], head = null;
  if (env.DB) {
    const { results } = await env.DB.prepare("SELECT pu_code, status, tally_json, discrepancy_json FROM unit_consensus WHERE race = ?1").bind(race).all();
    units = results.map((r) => ({ pu_code: r.pu_code, status: r.status, tally: r.tally_json ? JSON.parse(r.tally_json) : null, irev: r.discrepancy_json ? JSON.parse(r.discrepancy_json) : null }));
    head = await env.DB.prepare("SELECT seq, hash FROM ledger_entries ORDER BY seq DESC LIMIT 1").first();
  }
  const res = Response.json(buildSnapshot(race, units, head), {
    headers: { "cache-control": "public, max-age=15", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" },
  });
  if (cache) { const put = cache.put(cacheKey, res.clone()); if (waitUntil) waitUntil(put); else await put; }
  return res;
}
