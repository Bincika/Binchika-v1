// Builds one row per race in results_snapshot from unit_consensus. Reads consensus; never writes to it or to the ledger.
// docs/results-precomputed-totals.md. Same filter as the public results have always used: high confidence, with a tally.
import { RESULTS_BODY_VERSION, RESULTS_RACES, resultsAccumulator, statusCounts } from "../../../functions/_lib/results-body.js";

const PAGE_SIZE = 2000;
// Rebuild at least this often even with no change, so built_at proves the Worker is alive.
export const REBUILD_EVERY_MS = 10 * 60 * 1000;

const UPSERT = `INSERT INTO results_snapshot (race, body_json, units, source_updated_at, built_at, format) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT (race) DO UPDATE SET body_json = excluded.body_json, units = excluded.units, source_updated_at = excluded.source_updated_at, built_at = excluded.built_at, format = excluded.format
  WHERE excluded.built_at >= results_snapshot.built_at`;

export async function buildRace(db, race, { now = Date.now, pageSize = PAGE_SIZE } = {}) {
  const started = now(), builtAt = new Date(started).toISOString();   // when the build began, so a slow older run can never win
  const stored = await db.prepare("SELECT source_updated_at, built_at, format FROM results_snapshot WHERE race = ?1").bind(race).first();
  // Read before page 1 and across all statuses: anything that changes during the build is newer than this, and the next tick rebuilds.
  const { latest = null } = (await db.prepare("SELECT MAX(updated_at) AS latest FROM unit_consensus WHERE race = ?1").bind(race).first()) ?? {};
  if (stored && stored.format === RESULTS_BODY_VERSION && stored.source_updated_at === latest && started - Date.parse(stored.built_at) < REBUILD_EVERY_MS) return { race, rebuilt: false };

  const totals = resultsAccumulator(race);
  let after = "", pages = 0, rows = 0;
  for (;;) {
    const { results } = await db.prepare("SELECT pu_code, tally_json, discrepancy_json FROM unit_consensus WHERE race = ?1 AND status = 'high' AND tally_json IS NOT NULL AND pu_code > ?2 ORDER BY pu_code LIMIT ?3").bind(race, after, pageSize).all();
    if (results.length) { totals.add(results); pages++; rows += results.length; after = results.at(-1).pu_code; }
    if (results.length < pageSize) break;
  }
  const body = totals.body();
  // For the press feed. A covering index, on rebuilds only, so no reader ever needs this count.
  const { results: statuses } = await db.prepare("SELECT status, COUNT(*) AS n FROM unit_consensus WHERE race = ?1 GROUP BY status").bind(race).all();
  body.statusCounts = statusCounts(statuses, body.units.reported);
  await db.prepare(UPSERT).bind(race, JSON.stringify(body), body.units.reported, latest, builtAt, RESULTS_BODY_VERSION).run();
  return { race, rebuilt: true, pages, rows };
}

/** Every race, one at a time. A failure leaves that race's last row in place, and the run still ends as failed so analytics show it. */
export async function runAll(env, { now = Date.now, log = console.log } = {}) {
  const outcomes = [], failed = [];
  for (const race of RESULTS_RACES) {
    try { outcomes.push(await buildRace(env.DB, race, { now })); }
    catch (error) { failed.push(race); outcomes.push({ race, failed: true, error: String(error?.message ?? error).slice(0, 120) }); }
  }
  log(JSON.stringify({ event: "results-snapshot", outcomes }));
  if (failed.length) throw new Error(`results-snapshot failed for: ${failed.join(", ")}`);
  return outcomes;
}
