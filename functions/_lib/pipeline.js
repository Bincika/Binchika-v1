// Unit pipeline: reports → consensus → compare with official → baseline → posting gates → unit_consensus → ledger append.
// D1-specific I/O lives here; the rules themselves are pure (consensus.js, ec8a.js, baseline.js, ledger.js, results.js).
import { unitConsensus, compareWithOfficial } from "./consensus.js";
import { checkAgainstBaseline } from "./baseline.js";
import { postingGates } from "./ec8a.js";
import { makeEntry, genesis } from "./ledger.js";
import { stateOfPu } from "./results.js";
import { guardReady, isClaimClash, isNotReadyError, isUniqueClash, tallyKey, recomputedHash } from "./correction-guard.js";

import { TENANT as CYCLE_TENANT } from "./tenant.generated.js";
export const CYCLE = CYCLE_TENANT.ledgerCycle;

export async function ledgerHead(db) {
  const row = await db.prepare("SELECT seq, hash FROM ledger_entries ORDER BY seq DESC LIMIT 1").first();
  return row ?? { seq: 0, hash: await genesis(CYCLE) };
}

/** Appends with optimistic concurrency on seq (PRIMARY KEY). Retries a few times on contention. */
export async function appendEntry(db, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const head = await ledgerHead(db);
    const entry = await makeEntry({ ...body, seq: head.seq + 1 }, head.hash);
    try {
      await db.prepare("INSERT INTO ledger_entries (seq, kind, pu_code, race, state_iso, body_json, prev, hash, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
        .bind(entry.seq, entry.kind, entry.pu_code, entry.race, stateOfPu(entry.pu_code), JSON.stringify(entry), entry.prev, entry.hash, entry.recordedAt).run();
      return entry;
    } catch (e) {
      if (!/UNIQUE|PRIMARY KEY|constraint/i.test(String(e))) throw e;
    }
  }
  throw new Error("ledger contention: could not append after 5 attempts");
}

/**
 * Re-evaluates one polling unit for one race. Appends to the ledger only when a high-confidence tally is new or changed
 * AND every posting gate passes (ec8a.js postingGates).
 * Which readings count (session 88, docs/protocol/AI-GOVERNANCE.md): a result-sheet reading counts only once a verifier
 * has confirmed it ("verified") or a calibrated machine reading cleared every field ("ocr_done"). "needs_review" no
 * longer counts. Alternative evidence (no Form R1) counts only once a verifier has approved it, and can only make a
 * unit "lower", never "high" (unitConsensus in consensus.js), so it never reaches the ledger on its own.
 * A unit that is high but fails a gate is stored as "held": it is not posted and is not in the public totals.
 */
export async function processUnit(db, puCode, race) {
  // Build plan 8 (correction-path hardening): until the migration exists (previews share the production database), the
  // guard is not ready and this is exactly the path of before, statement for statement.
  if (!(await guardReady(db))) return processUnitToday(db, puCode, race, await assessUnit(db, puCode, race));
  for (let attempt = 0; attempt < 5; attempt++) {
    const out = await processUnitGuarded(db, puCode, race, await assessUnit(db, puCode, race));
    if (out) return out;
  }
  throw new Error("unit contention: could not store after 5 attempts");
}

/** Reads the unit's reports and works out consensus, the official comparison, the baseline and the posting gates. */
async function assessUnit(db, puCode, race) {
  const { results: reps } = await db.prepare(
    `SELECT r.reporter_hash, r.tally_json, r.channel, r.evidence, r.audit_status, r.received_at, c.checks_ok, c.controls_json
       FROM reports r LEFT JOIN report_checks c ON c.report_id = r.id
      WHERE r.pu_code = ?1 AND r.race = ?2 AND r.tally_json IS NOT NULL AND r.status <> 'rejected' AND COALESCE(r.audit_status, '') <> 'rejected'
        AND (r.status IN ('ocr_done','verified') OR (r.evidence <> 'ec8a' AND r.audit_status = 'approved'))
      ORDER BY r.received_at`
  ).bind(puCode, race).all();
  const c = unitConsensus(reps.map((r) => ({ reporterHash: r.reporter_hash, tally: JSON.parse(r.tally_json), source: r.channel, evidence: r.evidence ?? "ec8a", audit: r.audit_status ?? null })));
  const off = await db.prepare("SELECT tally_json, source, fetched_at, document_url FROM official_results WHERE pu_code = ?1 AND race = ?2 ORDER BY fetched_at DESC LIMIT 1").bind(puCode, race).first();
  const discrepancy = c.tally && off?.tally_json ? compareWithOfficial(c.tally, JSON.parse(off.tally_json)) : null;

  // Baseline (baseline.js): on each counted sheet, accredited voters and votes cast may not exceed the register printed
  // on it. The worst finding across the counted sheets is kept.
  const order = { none: 0, material: 1, critical: 2 };
  let baseline = null;
  for (const r of reps.filter((x) => (x.evidence ?? "ec8a") === "ec8a")) {
    const k = r.controls_json ? JSON.parse(r.controls_json) : null;
    if (!k || !Number.isInteger(k.register)) continue;
    const valid = Object.values(JSON.parse(r.tally_json)).reduce((a, n) => a + Number(n), 0);
    const b = checkAgainstBaseline(k.register, { accredited: k.accredited, votesCast: valid + (k.rejected ?? 0) });
    if (!baseline || order[b.severity] > order[baseline.severity]) baseline = b;
  }
  // A high unit only ever comes from result sheets (alternatives make it "lower" at most), so the sheets are what is gated.
  const sheets = reps.filter((r) => (r.evidence ?? "ec8a") === "ec8a");
  const verdict = postingGates({ puCode, consensus: c, counted: sheets.map((r) => ({ checksOk: r.checks_ok === 1 })), baseline });
  const status = c.status === "high" && !verdict.post ? "held" : c.status;
  return { c, off, discrepancy, verdict, status, baseline };
}

const tallyBody = (puCode, race, { c, off, discrepancy, verdict }) => ({
  kind: "tally", pu_code: puCode, race,
  consensus: { status: c.status, share: c.share, reports: c.reports },
  tally: c.tally,
  official: off ? { source: off.source, tally: JSON.parse(off.tally_json), fetchedAt: off.fetched_at, document: off.document_url } : null,
  discrepancy,
  gates: { score: verdict.score, passed: verdict.gates.map((g) => g.id) },
});

/** The path of before the correction guard (unchanged): used while the migration is missing. */
async function processUnitToday(db, puCode, race, a) {
  const { c, discrepancy, verdict, status, baseline } = a;
  const prev = await db.prepare("SELECT tally_json, status FROM unit_consensus WHERE pu_code = ?1 AND race = ?2").bind(puCode, race).first();
  let entry = null;
  // New ledger entry when a unit first reaches high confidence and passes every gate, or when its posted tally changes.
  const changed = status === "high" && (prev?.status !== "high" || JSON.stringify(c.tally) !== prev?.tally_json);
  if (changed) {
    entry = await appendEntry(db, tallyBody(puCode, race, a));
  }
  await db.prepare(
    `INSERT INTO unit_consensus (pu_code, race, status, share, reports, tally_json, discrepancy_json, ledger_hash, gates_json, baseline_json, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (pu_code, race) DO UPDATE SET status = excluded.status, share = excluded.share, reports = excluded.reports,
       tally_json = excluded.tally_json, discrepancy_json = excluded.discrepancy_json,
       ledger_hash = COALESCE(excluded.ledger_hash, unit_consensus.ledger_hash), gates_json = excluded.gates_json,
       baseline_json = excluded.baseline_json, updated_at = excluded.updated_at`
  ).bind(puCode, race, status, c.share, c.reports, c.tally ? JSON.stringify(c.tally) : null, discrepancy ? JSON.stringify(discrepancy) : null, entry?.hash ?? null,
    JSON.stringify(verdict), baseline ? JSON.stringify(baseline) : null).run();
  return { consensus: { ...c, status }, discrepancy, ledgerEntry: entry, gates: verdict, baseline };
}

const UPSERT_SQL = `INSERT INTO unit_consensus (pu_code, race, status, share, reports, tally_json, discrepancy_json, ledger_hash, gates_json, baseline_json, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (pu_code, race) DO UPDATE SET status = excluded.status, share = excluded.share, reports = excluded.reports,
       tally_json = excluded.tally_json, discrepancy_json = excluded.discrepancy_json,
       ledger_hash = COALESCE(excluded.ledger_hash, unit_consensus.ledger_hash), gates_json = excluded.gates_json,
       baseline_json = excluded.baseline_json, updated_at = excluded.updated_at
     WHERE unit_consensus.correction_hash IS ?11`;

/**
 * The guarded path (build plan 8, sections 5.2 and 11). A unit is "corrected" only when its correction_hash equals its
 * ledger_hash (N2). A corrected unit whose recount differs (another tally, or no longer high) keeps its correction: no
 * tally entry, no change to the unit row at all (F4), and one conflict row for a person to decide through the normal
 * three-seat flag chain. Every other unit appends and stores as before, now in one batch that holds only if no correction
 * landed since the read (F3). Returns null when the write found the unit changed, so the caller reads again.
 */
async function processUnitGuarded(db, puCode, race, a) {
  const { c, discrepancy, verdict, status, baseline } = a;
  const prev = await db.prepare("SELECT tally_json, status, ledger_hash, correction_hash FROM unit_consensus WHERE pu_code = ?1 AND race = ?2").bind(puCode, race).first();
  const readCorrection = prev?.correction_hash ?? null;
  const corrected = !!readCorrection && readCorrection === prev.ledger_hash;
  let changed;
  if (corrected) {
    const same = status === "high" && tallyKey(c.tally) === tallyKey(prev.tally_json ? JSON.parse(prev.tally_json) : null);
    if (!same) {
      const key = tallyKey(c.tally);
      await db.prepare(
        `INSERT OR IGNORE INTO correction_conflicts (pu_code, race, correction_hash, recomputed_json, recomputed_status, recomputed_hash)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE EXISTS (SELECT 1 FROM unit_consensus WHERE pu_code = ?1 AND race = ?2 AND correction_hash = ?3 AND ledger_hash = ?3)`,
      ).bind(puCode, race, readCorrection, key, status, await recomputedHash(c.tally, status)).run();
      return { consensus: { ...c, status }, discrepancy, ledgerEntry: null, gates: verdict, baseline, correctionConflict: true };
    }
    changed = false;   // the recount agrees with the standing correction: nothing new for the ledger
  } else {
    changed = status === "high" && (prev?.status !== "high" || JSON.stringify(c.tally) !== prev?.tally_json);
  }

  let entry = null;
  const stmts = [];
  if (changed) {
    const head = await ledgerHead(db);
    entry = await makeEntry({ ...tallyBody(puCode, race, a), seq: head.seq + 1 }, head.hash);
    stmts.push(db.prepare(
      `INSERT INTO ledger_entries (seq, kind, pu_code, race, state_iso, body_json, prev, hash, recorded_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE (SELECT correction_hash FROM unit_consensus WHERE pu_code = ?3 AND race = ?4) IS ?10`,
    ).bind(entry.seq, entry.kind, entry.pu_code, entry.race, stateOfPu(entry.pu_code), JSON.stringify(entry), entry.prev, entry.hash, entry.recordedAt, readCorrection));
  }
  stmts.push(db.prepare(UPSERT_SQL).bind(puCode, race, status, c.share, c.reports, c.tally ? JSON.stringify(c.tally) : null, discrepancy ? JSON.stringify(discrepancy) : null,
    entry?.hash ?? null, JSON.stringify(verdict), baseline ? JSON.stringify(baseline) : null, readCorrection));
  let res;
  try {
    res = await db.batch(stmts);
  } catch (e) {
    if (isUniqueClash(e)) return null;   // a seq or hash clash: read the head again
    throw e;
  }
  if (res.some((r) => (r?.meta?.changes ?? 0) === 0)) return null;   // a correction landed since the read
  return { consensus: { ...c, status }, discrepancy, ledgerEntry: entry, gates: verdict, baseline };
}

/**
 * Admin-approved correction after AI re-investigation: a correction entry; history is never edited.
 * Build plan 8, section 5.1: one D1 batch (one transaction) writes the claim (one per flag), the ledger entry, the unit and
 * the resolution of the unit's open conflicts, all conditional on the unit still being posted with the hash the route read.
 * Returns { entry } or { refused: "not_ready" | "already_decided" | "unit_changed" | "busy" }; on a refusal nothing is written.
 */
export async function recordCorrection(db, { puCode, race, tally, flagId, reason, supersedes, expectedHash }) {
  if (!(await guardReady(db))) return { refused: "not_ready" };
  const posted = "EXISTS (SELECT 1 FROM unit_consensus WHERE pu_code = ?2 AND race = ?3 AND status = 'high' AND ledger_hash = ?4)";
  for (let attempt = 0; attempt < 5; attempt++) {
    const head = await ledgerHead(db);
    const entry = await makeEntry({ kind: "correction", pu_code: puCode, race, tally, flag: flagId, reason, supersedes: supersedes ?? null, seq: head.seq + 1 }, head.hash);
    const stmts = [
      db.prepare(`INSERT INTO correction_claims (flag_id, pu_code, race, ledger_hash) SELECT ?1, ?2, ?3, ?5 WHERE ${posted}`)
        .bind(flagId, puCode, race, expectedHash, entry.hash),
      db.prepare(`INSERT INTO ledger_entries (seq, kind, pu_code, race, state_iso, body_json, prev, hash, recorded_at)
                  SELECT ?1, 'correction', ?2, ?3, ?5, ?6, ?7, ?8, ?9 WHERE ${posted}`)
        .bind(entry.seq, puCode, race, expectedHash, stateOfPu(puCode), JSON.stringify(entry), entry.prev, entry.hash, entry.recordedAt),
      db.prepare(`UPDATE unit_consensus SET tally_json = ?1, status = 'high', ledger_hash = ?5, correction_hash = ?5, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                   WHERE pu_code = ?2 AND race = ?3 AND status = 'high' AND ledger_hash = ?4`)
        .bind(JSON.stringify(tally), puCode, race, expectedHash, entry.hash),
      db.prepare(`UPDATE correction_conflicts SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by_hash = ?3
                   WHERE pu_code = ?1 AND race = ?2 AND resolved_at IS NULL
                     AND EXISTS (SELECT 1 FROM correction_claims WHERE flag_id = ?4 AND ledger_hash = ?3)`)
        .bind(puCode, race, entry.hash, flagId),
    ];
    let res;
    try {
      res = await db.batch(stmts);
    } catch (e) {
      if (isClaimClash(e)) return { refused: "already_decided" };
      if (isNotReadyError(e)) return { refused: "not_ready" };
      if (isUniqueClash(e)) continue;   // a seq or hash clash: retry on the new head
      throw e;
    }
    if ((res[1]?.meta?.changes ?? 0) === 0) return { refused: "unit_changed" };
    return { entry };
  }
  return { refused: "busy" };
}
