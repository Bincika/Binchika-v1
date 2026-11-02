// GET /api/results?race=president — high-confidence citizen tallies aggregated by state.
// Not official results. Only INEC declares results.
import { aggregate, aggregateByLga, eligibleStateForRace, leader, spread, stateOfPu } from "../_lib/results.js";
import { TENANT } from "../_lib/tenant.generated.js";   // body name, polling-unit total (session 98)

const RACES = new Set(["president", "senate", "house", "governor", "state-assembly"]);

export async function onRequestGet({ request, env }) {
  const race = new URL(request.url).searchParams.get("race") ?? "president";
  if (!RACES.has(race)) return Response.json({ error: "unknown race" }, { status: 400 });
  let rows = [];
  if (env.DB) {
    const { results } = await env.DB.prepare("SELECT pu_code, tally_json, discrepancy_json FROM unit_consensus WHERE race = ?1 AND status = 'high' AND tally_json IS NOT NULL").bind(race).all();
    rows = results.map((r) => ({ pu_code: r.pu_code, tally: JSON.parse(r.tally_json), irev: r.discrepancy_json ? JSON.parse(r.discrepancy_json) : null }));
  }
  rows = rows.filter((row) => eligibleStateForRace(race, stateOfPu(row.pu_code)));
  const agg = aggregate(rows);
  const byState = Object.fromEntries(Object.entries(agg.byState).map(([iso, s]) => [iso, { ...s, leader: leader(s.totals) }]));
  return Response.json({
    race,
    notice: `Citizen-verified tallies (high confidence only). Not official results. Only ${TENANT.electoralBody.short} declares results.`,
    units: { reported: agg.units, total: TENANT.pollingUnits.total, totalSource: TENANT.pollingUnits.totalSource },
    national: { totals: agg.national, leader: leader(agg.national) },
    spread: spread(Object.fromEntries(Object.entries(agg.byState).map(([k, v]) => [k, v.totals]))),
    byState,
    byLga: aggregateByLga(rows),
    // Session 88: how many published units have an official (IReV) figure, and how many of those differ. Counts only;
    // the per-party differences are on each ledger entry with both tallies and the document link.
    irev: { compared: rows.filter((r) => r.irev).length, mismatches: rows.filter((r) => r.irev && r.irev.match === false).length,
      note: "A difference is shown, not hidden: the citizen tally is published beside the official figure. Only INEC declares results." },
    updatedAt: new Date().toISOString(),
  }, { headers: { "cache-control": "public, max-age=15" } });
}
