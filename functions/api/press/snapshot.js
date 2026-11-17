// GET /api/press/snapshot?race=president — one read-only document for press desks and civic groups (session 88;
// docs/PRESS-FEED-DESIGN.md). Built only from what /api/results and /api/ledger already publish: totals by state,
// unit counts by confidence, the ledger head and the ERP comparison counts. No photographs, captions, report rows,
// hashes of reporters, verifier IDs, contact text or projections. GET only; no key in the URL.
// Reader path (session 112): the row workers/results-snapshot stores for /api/results, plus the ledger head. It never scans unit_consensus.
// RESULTS_SOURCE unset is the off switch: the earlier scan below, kept until after the second polling day.
// Flood resistance: the response is cached at the edge for 15 s per race (caches.default), so repeated calls do not
// reach the database; an optional Cloudflare rate-limit rule is described in docs/PRESS-FEED-DESIGN.md.
import { RESULTS_CACHE_SECONDS, readThroughCache } from "../../_lib/edge-cache.js";
import { aggregate, eligibleStateForRace, stateOfPu } from "../../_lib/results.js";
import { SNAPSHOT_MAX_AGE_MS } from "../../_lib/results-body.js";
import { TENANT } from "../../_lib/tenant.generated.js";

const RACES = new Set(["president", "senate", "house", "governor", "state-assembly"]);
export const PRESS_NOTICE = TENANT.notice;   // tenants/<id>/tenant.json (session 98)
const HEADERS = { "access-control-allow-origin": "*", "x-content-type-options": "nosniff" };

/** The public document. One definition of its fields and wording, whichever path supplies the figures. */
const pressDocument = ({ race, head, now, figuresBuiltAt, published, lowerConfidence, held, notYetHigh, national, byState, compared, mismatches }) => ({
  notice: PRESS_NOTICE,
  race,
  updatedAt: now.toISOString(),
  figuresBuiltAt,   // session 114: more than about 12 minutes older than updatedAt means the Worker has stopped or is delayed
  ledger: { head: head?.hash ?? null, count: head?.seq ?? 0, verify: "https://binchika.com/ledger/" },
  units: { published, lowerConfidence, held, notYetHigh, denominator: TENANT.pollingUnits.total, denominatorSource: TENANT.pollingUnits.totalSource },
  national: { totals: national },
  byState: Object.fromEntries(Object.entries(byState).map(([iso, s]) => [iso, { units: s.units, totals: s.totals }])),
  irev: { compared, mismatches },
  rules: TENANT.text.pressRules,
});

/** The snapshot body from unit rows and the ledger head. Pure; exported for tests. */
export function buildSnapshot(race, units, head, now = new Date()) {
  const high = units.filter((u) => u.status === "high" && u.tally && eligibleStateForRace(race, stateOfPu(u.pu_code)));
  const agg = aggregate(high.map((u) => ({ pu_code: u.pu_code, tally: u.tally })));
  const count = (s) => units.filter((u) => u.status === s).length;
  return pressDocument({
    race, head, now, figuresBuiltAt: now.toISOString(), published: high.length, lowerConfidence: count("lower"), held: count("held"), notYetHigh: units.length - high.length - count("lower") - count("held"),
    national: agg.national, byState: agg.byState,
    compared: high.filter((u) => u.irev).length, mismatches: high.filter((u) => u.irev && u.irev.match === false).length,
  });
}

/** The same document from a stored results body. Fields are picked by name, so leader, spread, byLga and the results notice cannot reach this feed. Pure. */
export function snapshotFromStored(race, stored, builtAt, head, now = new Date()) {
  const { lowerConfidence, held, notYetHigh } = stored.statusCounts;
  return pressDocument({
    race, head, now, figuresBuiltAt: builtAt, published: stored.units.reported, lowerConfidence, held, notYetHigh,
    national: stored.national.totals, byState: stored.byState,
    compared: stored.irev.compared, mismatches: stored.irev.mismatches,
  });
}

async function fromStoredRow(race, env) {
  const row = env.DB ? await env.DB.prepare("SELECT body_json, built_at FROM results_snapshot WHERE race = ?1").bind(race).first() : null;
  const stored = row && Date.now() - Date.parse(row.built_at) <= SNAPSHOT_MAX_AGE_MS ? JSON.parse(row.body_json) : null;
  // Missing, too old or from an older Worker: say so. Never scan from a reader's request, and never let a fault read as "no reports".
  if (!stored?.statusCounts) return { response: Response.json({ error: "results temporarily unavailable" }, { status: 503, headers: { ...HEADERS, "cache-control": "no-store" } }), store: false };
  // The head stays live: it is not per race, and the Worker never reads the ledger. Two primary-key searches, one row.
  const head = await env.DB.prepare("SELECT seq, hash FROM ledger_entries WHERE seq = (SELECT MAX(seq) FROM ledger_entries)").first();
  const response = Response.json(snapshotFromStored(race, stored, row.built_at, head), { headers: { ...HEADERS, "cache-control": `public, max-age=${RESULTS_CACHE_SECONDS}`, "x-binchika-figures-built": row.built_at } });
  return { response, store: true };
}

export async function onRequestGet({ request, env, waitUntil }) {
  const race = new URL(request.url).searchParams.get("race") ?? "president";
  if (!RACES.has(race)) return Response.json({ error: "unknown race" }, { status: 400 });
  const cacheKey = new Request(`https://binchika.com/api/press/snapshot?race=${race}`);
  if (env.RESULTS_SOURCE === "snapshot") return readThroughCache({ key: cacheKey, waitUntil, build: () => fromStoredRow(race, env) });
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
