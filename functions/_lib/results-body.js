// One definition of the /api/results body, used by the reader's fallback path and by workers/results-snapshot (session 111).
// docs/results-precomputed-totals.md. Pure. The rules stay in results.js; this only adds totals up a page at a time.
import { aggregate, aggregateByLga, eligibleStateForRace, leader, spread, stateOfPu } from "./results.js";
import { TENANT } from "./tenant.generated.js";   // body name, polling-unit total (session 98)

export const RESULTS_RACES = ["president", "senate", "house", "governor", "state-assembly"];
// Raise this when the body's shape or wording changes: stored rows are then rebuilt on the next tick, even with no new reports.
export const RESULTS_BODY_VERSION = 2;   // 2: statusCounts, for /api/press/snapshot (session 112)
// A row older than this means the Worker has stopped. Readers get a 503, so the page says the refresh failed, not that figures are current.
export const SNAPSHOT_MAX_AGE_MS = 20 * 60 * 1000;

const addTotals = (into, totals) => { for (const [party, votes] of Object.entries(totals)) into[party] = (into[party] ?? 0) + votes; };

/** Add rows { pu_code, tally_json, discrepancy_json } in any number of pages; keeps totals, not rows. */
export function resultsAccumulator(race) {
  const national = {}, byState = {}, byLga = {};
  let units = 0, compared = 0, mismatches = 0;
  return {
    add(page) {
      const rows = page.map((r) => ({ pu_code: r.pu_code, tally: JSON.parse(r.tally_json), irev: r.discrepancy_json ? JSON.parse(r.discrepancy_json) : null }))
        .filter((row) => eligibleStateForRace(race, stateOfPu(row.pu_code)));
      const part = aggregate(rows);
      units += part.units;
      addTotals(national, part.national);
      for (const [iso, area] of Object.entries(part.byState)) {
        const into = (byState[iso] ??= { units: 0, totals: {} });
        into.units += area.units;
        addTotals(into.totals, area.totals);
      }
      for (const [iso, areas] of Object.entries(aggregateByLga(rows))) for (const [code, area] of Object.entries(areas)) {
        const into = ((byLga[iso] ??= {})[code] ??= { units: 0, totals: {} });
        into.units += area.units;
        addTotals(into.totals, area.totals);
      }
      for (const row of rows) if (row.irev) { compared++; if (row.irev.match === false) mismatches++; }
    },
    /** The public body, without updatedAt: that belongs to the response. */
    body() {
      const states = Object.fromEntries(Object.entries(byState).map(([iso, s]) => [iso, { ...s, leader: leader(s.totals) }]));
      const lgas = Object.fromEntries(Object.entries(byLga).map(([iso, areas]) => [iso, Object.fromEntries(Object.entries(areas).map(([code, area]) => [code, { ...area, leader: leader(area.totals) }]))]));
      return {
        race,
        notice: `Citizen-verified tallies (high confidence only). Not official results. Only ${TENANT.electoralBody.short} declares results.`,
        units: { reported: units, total: TENANT.pollingUnits.total, totalSource: TENANT.pollingUnits.totalSource },
        national: { totals: national, leader: leader(national) },
        spread: spread(Object.fromEntries(Object.entries(byState).map(([k, v]) => [k, v.totals]))),
        byState: states,
        byLga: lgas,
        // Session 88: how many published units have an official (ERP) figure, and how many of those differ. Counts only;
        // the per-party differences are on each ledger entry with both tallies and the document link.
        irev: { compared, mismatches,
          note: `A difference is shown, not hidden: the citizen tally is published beside the official figure. Only ${TENANT.electoralBody.short} declares results.` },
      };
    },
  };
}

/** Units not in the totals, from rows { status, n } over the whole race; reported is the published count from the same build.
 * A unit changing status during a build can make the sum a little out, so it stops at zero; its new updated_at makes the next tick rebuild. */
export function statusCounts(rows, reported) {
  const count = (status) => rows.find((r) => r.status === status)?.n ?? 0;
  const all = rows.reduce((sum, r) => sum + r.n, 0);
  return { lowerConfidence: count("lower"), held: count("held"), notYetHigh: Math.max(0, all - reported - count("lower") - count("held")) };
}

/** A stored body as a response, without parsing it: the cost stays flat however many units have reported. */
export const servedBody = (bodyJson, builtAt, updatedAt) => `${bodyJson.slice(0, -1)},"builtAt":${JSON.stringify(builtAt)},"updatedAt":${JSON.stringify(updatedAt)}}`;
