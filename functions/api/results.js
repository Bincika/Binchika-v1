// GET /api/results?race=president — high-confidence citizen tallies aggregated by state.
// Not official results. Only EEC declares results.
// Reader path (session 111): one precomputed row per race, built by workers/results-snapshot. It never scans unit_consensus.
// RESULTS_SOURCE unset is the off switch: the earlier scan below, kept until after the second polling day.
// Flood resistance: cached at the edge per race (session 108), so election-night polling does not read D1 on every request.
// The response is public and never varies by who asks, so there is no bypass: a header must not be a way round the cache to D1.
import { RESULTS_CACHE_SECONDS, readThroughCache } from "../_lib/edge-cache.js";
import { RESULTS_RACES, SNAPSHOT_MAX_AGE_MS, resultsAccumulator, servedBody } from "../_lib/results-body.js";

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const race = url.searchParams.get("race") ?? "president";
  if (!RESULTS_RACES.includes(race)) return Response.json({ error: "unknown race" }, { status: 400 });
  const build = env.RESULTS_SOURCE === "snapshot" ? fromSnapshot : fromScan;
  // Only the validated race is in the key, so added parameters cannot force a fresh read.
  return readThroughCache({ key: new Request(`${url.origin}/api/results?race=${race}`), waitUntil, build: () => build(race, env) });
}

async function fromSnapshot(race, env) {
  const row = env.DB ? await env.DB.prepare("SELECT body_json, built_at FROM results_snapshot WHERE race = ?1").bind(race).first() : null;
  // Missing or too old: say so. Never scan from a reader's request, and never let a fault read as "no reports".
  if (!row || Date.now() - Date.parse(row.built_at) > SNAPSHOT_MAX_AGE_MS) {
    return { response: Response.json({ error: "results temporarily unavailable" }, { status: 503, headers: { "cache-control": "no-store" } }), store: false };
  }
  const response = new Response(servedBody(row.body_json, row.built_at, new Date().toISOString()), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${RESULTS_CACHE_SECONDS}` } });
  return { response, store: true };
}

async function fromScan(race, env) {
  const totals = resultsAccumulator(race);
  if (env.DB) {
    const { results } = await env.DB.prepare("SELECT pu_code, tally_json, discrepancy_json FROM unit_consensus WHERE race = ?1 AND status = 'high' AND tally_json IS NOT NULL").bind(race).all();
    totals.add(results);
  }
  const response = Response.json({ ...totals.body(), updatedAt: new Date().toISOString() }, { headers: { "cache-control": `public, max-age=${RESULTS_CACHE_SECONDS}` } });
  // A missing database binding gives an empty 200: never let that fault be cached as "no reports".
  return { response, store: Boolean(env.DB) };
}
