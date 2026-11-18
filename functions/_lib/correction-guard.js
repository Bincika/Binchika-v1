// Correction-path hardening (build plan 8, docs/CORRECTION-PATH-BUILD-PLAN.md, sections 5 and 11).
// The guard is "ready" only once the migration has added unit_consensus.correction_hash and the two tables
// correction_claims and correction_conflicts. Previews share the production database, so until then the code fails
// closed: approving a correction is refused (503), the admin list answers 503, and processUnit runs exactly today's path.
// No personal data is read or written here: units, races, tallies, hashes and a flag id only.
import { canonical, sha256Hex } from "./ledger.js";

const PROBES = [
  "SELECT correction_hash FROM unit_consensus LIMIT 0",
  "SELECT flag_id FROM correction_claims LIMIT 0",
  "SELECT recomputed_hash FROM correction_conflicts LIMIT 0",
];

/** True only when every new column and table answers. Any error at all counts as "not ready" (fail closed). */
export async function guardReady(db) {
  if (!db) return false;
  try {
    if (typeof db.batch === "function") await db.batch(PROBES.map((sql) => db.prepare(sql)));
    else for (const sql of PROBES) await db.prepare(sql).all();
    return true;
  } catch {
    return false;
  }
}

/** A missing table or column from one of the new statements also means "not ready". */
export const isNotReadyError = (e) => /no such (table|column)/i.test(String(e?.message ?? e));

/** Gate 1, F1: a claim clash is recognised only by the claim table's key; every other unique error is a seq or hash clash. */
export const isClaimClash = (e) => /correction_claims\.flag_id/.test(String(e?.message ?? e));

export const isUniqueClash = (e) => /UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e));

/** Gate 1, F6: tallies compare as canonical JSON with party keys upper-cased, as checkTally stores them. */
export function tallyKey(tally) {
  if (!tally || typeof tally !== "object") return null;
  return canonical(Object.fromEntries(Object.entries(tally).map(([k, v]) => [k.toUpperCase(), v])));
}

export async function recomputedHash(tally, status) {
  const up = tally && typeof tally === "object" ? Object.fromEntries(Object.entries(tally).map(([k, v]) => [k.toUpperCase(), v])) : null;
  return sha256Hex(canonical({ tally: up, status }));
}
