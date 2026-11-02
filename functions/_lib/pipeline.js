// Unit pipeline: reports → consensus → compare with official → baseline → posting gates → unit_consensus → ledger append.
// D1-specific I/O lives here; the rules themselves are pure (consensus.js, ec8a.js, baseline.js, ledger.js, results.js).
import { unitConsensus, compareWithOfficial } from "./consensus.js";
import { checkAgainstBaseline } from "./baseline.js";
import { postingGates } from "./ec8a.js";
import { makeEntry, genesis } from "./ledger.js";
import { stateOfPu } from "./results.js";

export const CYCLE = "ng-2027";

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
 * longer counts. Alternative evidence (no Form EC8A) counts only once a verifier has approved it, and can only make a
 * unit "lower", never "high" (unitConsensus in consensus.js), so it never reaches the ledger on its own.
 * A unit that is high but fails a gate is stored as "held": it is not posted and is not in the public totals.
 */
export async function processUnit(db, puCode, race) {
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
  const prev = await db.prepare("SELECT tally_json, status FROM unit_consensus WHERE pu_code = ?1 AND race = ?2").bind(puCode, race).first();

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

  let entry = null;
  // New ledger entry when a unit first reaches high confidence and passes every gate, or when its posted tally changes.
  const changed = status === "high" && (prev?.status !== "high" || JSON.stringify(c.tally) !== prev?.tally_json);
  if (changed) {
    entry = await appendEntry(db, {
      kind: "tally", pu_code: puCode, race,
      consensus: { status: c.status, share: c.share, reports: c.reports },
      tally: c.tally,
      official: off ? { source: off.source, tally: JSON.parse(off.tally_json), fetchedAt: off.fetched_at, document: off.document_url } : null,
      discrepancy,
      gates: { score: verdict.score, passed: verdict.gates.map((g) => g.id) },
    });
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

/** Admin-approved overwrite after AI re-investigation: a correction entry; history is never edited. */
export async function recordCorrection(db, { puCode, race, tally, flagId, reason, supersedes }) {
  const entry = await appendEntry(db, { kind: "correction", pu_code: puCode, race, tally, flag: flagId, reason, supersedes: supersedes ?? null });
  await db.prepare("UPDATE unit_consensus SET tally_json = ?3, status = 'high', ledger_hash = ?4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE pu_code = ?1 AND race = ?2")
    .bind(puCode, race, JSON.stringify(tally), entry.hash).run();
  return entry;
}
