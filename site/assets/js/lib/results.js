// Aggregation + Nigeria's constitutional winning rules. Pure, shared by API and tests.
//
// President — Constitution s.134(2): highest votes AND at least 25% of votes in at least two-thirds
// of all the States and the FCT. Binchika shows the spread count; the courts, not Binchika, interpret it.
// Governor — Constitution s.179(2): highest votes AND at least 25% in at least two-thirds of the LGAs.

// Polling-unit code prefix → admin-1 area (ISO 3166-2), from the active tenant (tenants/<id>/tenant.json,
// pollingUnits.statePrefix; session 98). For Nigeria: INEC state codes, alphabetical, FCT = 37. VERIFY against INEC PU register.
import { TENANT } from "./tenant.generated.js";
export const REGION_CODE = TENANT.pollingUnits.statePrefix;
export const INEC_STATE_CODE = REGION_CODE;   // original name, kept for every existing import

export const stateOfPu = (pu) => INEC_STATE_CODE[String(pu ?? "").slice(0, 2)] ?? null;

// Nigeria / INEC 2027 scope, mirrored in site/data/races.json. The eight off-cycle
// governorship exclusions remain verified:false there pending INEC's final 2027 notice.
const GOVERNOR_OFF_CYCLE = new Set(["NG-AN", "NG-BY", "NG-ED", "NG-EK", "NG-IM", "NG-KO", "NG-ON", "NG-OS"]);
const STATE_ISOS = new Set(Object.values(INEC_STATE_CODE));
export function eligibleStateForRace(race, iso) {
  if (!STATE_ISOS.has(iso)) return false;
  if (["president", "senate", "house"].includes(race)) return true;
  if (race === "governor") return iso !== "NG-FC" && !GOVERNOR_OFF_CYCLE.has(iso);
  return race === "state-assembly" && iso !== "NG-FC";
}

/** rows: [{ pu_code, tally: {PARTY: n} }] (high-confidence only) → per-state and national totals. */
export function aggregate(rows) {
  const byState = {};
  const national = {};
  let units = 0;
  for (const r of rows) {
    const iso = stateOfPu(r.pu_code);
    if (!iso || !r.tally) continue;
    units++;
    const s = (byState[iso] ??= { units: 0, totals: {} });
    s.units++;
    for (const [p, v] of Object.entries(r.tally)) {
      s.totals[p] = (s.totals[p] ?? 0) + v;
      national[p] = (national[p] ?? 0) + v;
    }
  }
  return { units, national, byState };
}

/** Valid PU codes only; numeric prefixes identify LGAs without claiming a name mapping. */
export function aggregateByLga(rows) {
  const byLga = {};
  for (const row of rows) {
    if (!/^\d{2}-\d{2}-\d{2}-\d{3}$/.test(row.pu_code ?? "") || !row.tally) continue;
    const iso = stateOfPu(row.pu_code);
    if (!iso) continue;
    const code = row.pu_code.slice(0, 5);
    const area = ((byLga[iso] ??= {})[code] ??= { units: 0, totals: {} });
    area.units++;
    for (const [party, votes] of Object.entries(row.tally)) area.totals[party] = (area.totals[party] ?? 0) + votes;
  }
  for (const areas of Object.values(byLga)) for (const area of Object.values(areas)) area.leader = leader(area.totals);
  return byLga;
}

export const leader = (totals) => {
  const ranked = Object.entries(totals ?? {}).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] === 0) return null;
  if (ranked[1] && ranked[1][1] === ranked[0][1]) return { party: null, tie: true, votes: ranked[0][1] };
  const sum = ranked.reduce((a, [, v]) => a + v, 0);
  return { party: ranked[0][0], votes: ranked[0][1], share: ranked[0][1] / sum, margin: ranked[0][1] - (ranked[1]?.[1] ?? 0) };
};

/** For each party: in how many areas it has ≥25% of the votes counted so far. */
export function spread(areaTotals) {
  const out = {};
  for (const totals of Object.values(areaTotals)) {
    const sum = Object.values(totals).reduce((a, v) => a + v, 0);
    if (!sum) continue;
    for (const [p, v] of Object.entries(totals)) if (v / sum >= 0.25) out[p] = (out[p] ?? 0) + 1;
  }
  return out;
}

/** Two-thirds threshold, rounded up (e.g. 24 of 36, 25 of 37, 30 of 44 LGAs). */
export const twoThirds = (n) => Math.ceil((2 * n) / 3);
