import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseReport, isLowerEvidence, EVIDENCE } from "../functions/_lib/report.js";
import { unitConsensus } from "../functions/_lib/consensus.js";
import { processUnit } from "../functions/_lib/pipeline.js";
import { auditEvidence } from "../functions/_lib/evidence.js";
import { onRequestPost as postReport } from "../functions/api/reports.js";

// A D1 stand-in on a real SQLite database with the real D1 migrations, so the SQL itself is tested.
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_ledger.sql", "0005_evidence.sql", "0008_report_checks.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { db, prepare: (sql) => stmt(sql) };
}
const T = { APC: 100, PDP: 80 }, U = { APC: 90, PDP: 95 };
const rep = (h, tally, evidence = "ec8a", audit = null) => ({ reporterHash: h, tally, evidence, audit });
let n = 0;
// Session 88: a result-sheet reading counts only once a verifier has confirmed it, and is posted only if its sheet
// balances, so result sheets here are "verified" with balanced control totals; alternatives keep "needs_review".
function addReport(D1, { pu = "24-09-05-012", race = "president", tally = T, evidence = "ec8a", audit = null } = {}) {
  const id = `r${++n}`;
  D1.db.prepare("INSERT INTO reports (id, channel, reporter_hash, pu_code, race, tally_json, status, evidence, audit_status) VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?)")
    .run(id, `h${n}`, pu, race, JSON.stringify(tally), evidence === "ec8a" ? "verified" : "needs_review", evidence, audit);
  if (evidence === "ec8a") {
    const valid = Object.values(tally).reduce((a, v) => a + v, 0);
    D1.db.prepare("INSERT INTO report_checks (report_id, controls_json, checks_ok) VALUES (?, ?, 1)").run(id, JSON.stringify({ register: 1000, accredited: valid + 10, rejected: 2 }));
  }
  return id;
}
const unit = (D1) => D1.db.prepare("SELECT status, reports FROM unit_consensus WHERE pu_code = '24-09-05-012' AND race = 'president'").get();
const ledgerCount = (D1) => D1.db.prepare("SELECT COUNT(*) AS c FROM ledger_entries").get().c;
const LAGOS_SZV = { role: "szv", public_id: "V0007", states: ["NG-LA"] };
const NOTE = "Video shows the board at this unit; numbers match.";

test("evidence: reports default to the result sheet; only the three published alternatives are accepted", () => {
  assert.deepEqual(EVIDENCE, ["ec8a", "video", "handwritten", "board"]);
  assert.equal(parseReport({ channel: "web", handle: "x", tally: T }).value.evidence, "ec8a");
  assert.equal(parseReport({ channel: "web", handle: "x", tally: T, evidence: "board" }).value.evidence, "board");
  assert.match(parseReport({ channel: "web", handle: "x", tally: T, evidence: "selfie" }).errors.join(), /evidence must be one of/);
  assert.equal(isLowerEvidence("ec8a"), false);
  assert.equal(isLowerEvidence(undefined), false);
  assert.equal(isLowerEvidence("video"), true);
});

test("consensus: alternatives count only after audit, and can never make a unit high-confidence", () => {
  assert.equal(unitConsensus([rep("a", T), rep("b", T), rep("c", T)]).status, "high", "three result sheets agree: high, as before");
  const pending = unitConsensus([rep("a", T), rep("b", T), rep("c", T, "board", "pending")]);
  assert.equal(pending.status, "medium", "pending alternative is left out");
  assert.equal(pending.pendingAudit, 1);
  const approved = unitConsensus([rep("a", T), rep("b", T), rep("c", T, "board", "approved")]);
  assert.deepEqual([approved.status, approved.evidence, approved.alternatives], ["lower", "mixed", 1], "needed an alternative: lower-confidence");
  assert.deepEqual(approved.tally, T);
  assert.equal(unitConsensus([rep("a", T, "video", "approved"), rep("b", T, "handwritten", "approved"), rep("c", T, "board", "approved")]).status, "lower", "alternatives alone: never high");
  assert.equal(unitConsensus([rep("a", T), rep("b", T), rep("c", T, "board", "rejected")]).status, "medium", "rejected alternative is left out");
  const high = unitConsensus([rep("a", T), rep("b", T), rep("c", T), rep("d", U, "board", "approved")]);
  assert.deepEqual([high.status, high.evidence], ["high", "ec8a"], "result sheets already agree: alternatives change nothing");
  assert.equal(unitConsensus([rep("a", T), rep("b", T, "video", "approved")]).status, "medium", "below high stays as computed, marked mixed");
});

test("pipeline (real SQL): an audited alternative gives a lower-confidence unit with no ledger entry; result sheets then reach the ledger", async () => {
  const D1 = sqliteD1();
  addReport(D1); addReport(D1); addReport(D1, { evidence: "board", audit: "pending" });
  assert.equal((await processUnit(D1, "24-09-05-012", "president")).consensus.status, "medium");
  D1.db.prepare("UPDATE reports SET audit_status = 'approved' WHERE evidence = 'board'").run();
  const lower = await processUnit(D1, "24-09-05-012", "president");
  assert.deepEqual([lower.consensus.status, unit(D1).status, lower.ledgerEntry, ledgerCount(D1)], ["lower", "lower", null, 0]);
  assert.equal(D1.db.prepare("SELECT COUNT(*) c FROM unit_consensus WHERE status = 'high'").get().c, 0, "results (high only) do not include it");
  addReport(D1);
  const high = await processUnit(D1, "24-09-05-012", "president");
  assert.deepEqual([high.consensus.status, high.consensus.evidence, ledgerCount(D1)], ["high", "ec8a", 1], "three result sheets: high, one ledger entry");
  D1.db.prepare("INSERT INTO reports (id, channel, reporter_hash, pu_code, race, tally_json, status, evidence, audit_status) VALUES ('x', 'web', 'hx', '24-09-05-012', 'president', ?, 'needs_review', 'video', 'rejected')").run(JSON.stringify(U));
  const after = await processUnit(D1, "24-09-05-012", "president");
  assert.deepEqual([after.consensus.status, after.consensus.tally, after.consensus.pendingAudit, ledgerCount(D1)], ["high", T, 0, 1], "a rejected alternative changes nothing and adds no entry");
  assert.equal(D1.db.prepare("SELECT evidence FROM reports WHERE id = 'r1'").get().evidence, "ec8a");
});

test("audit: only an SZV/NRV for that state, only pending alternatives, always with a reason; the unit is re-evaluated", async () => {
  const D1 = sqliteD1();
  addReport(D1); addReport(D1);
  const alt = addReport(D1, { evidence: "handwritten", audit: "pending" });
  const sheet = addReport(D1, { pu: "24-09-05-013" });
  assert.equal((await auditEvidence(D1, { reportId: alt, decision: "approved", note: NOTE }, { ...LAGOS_SZV, states: ["NG-KN"] })).status, 403, "other state");
  assert.equal((await auditEvidence(D1, { reportId: alt, decision: "approved", note: NOTE }, { role: "admin", public_id: "V0002", states: ["NG-LA"] })).status, 403, "OpsAdmin cannot audit");
  assert.equal((await auditEvidence(D1, { reportId: alt, decision: "approved", note: "ok" }, LAGOS_SZV)).status, 422, "reason required");
  assert.equal((await auditEvidence(D1, { reportId: alt, decision: "maybe", note: NOTE }, LAGOS_SZV)).status, 422);
  assert.equal((await auditEvidence(D1, { reportId: sheet, decision: "approved", note: NOTE }, LAGOS_SZV)).status, 409, "result sheets need no audit");
  assert.equal((await auditEvidence(D1, { reportId: "nope", decision: "approved", note: NOTE }, LAGOS_SZV)).status, 404);
  const ok = await auditEvidence(D1, { reportId: alt, decision: "approved", note: NOTE }, LAGOS_SZV);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.unit, { status: "lower", evidence: "mixed", ledger: false });
  const row = D1.db.prepare("SELECT audit_status, audited_by, audit_note, audited_at FROM reports WHERE id = ?").get(alt);
  assert.deepEqual([row.audit_status, row.audited_by, row.audit_note, Boolean(row.audited_at)], ["approved", "V0007", NOTE, true]);
  assert.equal((await auditEvidence(D1, { reportId: alt, decision: "rejected", note: NOTE }, LAGOS_SZV)).status, 409, "decided once");
  const nrv = { role: "nrv", public_id: "V0042", states: ["NG-LA", "NG-OG", "NG-OY"] };
  const alt2 = addReport(D1, { evidence: "video", audit: "pending" });
  assert.equal((await auditEvidence(D1, { reportId: alt2, decision: "rejected", note: NOTE }, nrv)).status, 200, "the region's NRV can audit");
});

test("ingestion: alternative evidence is stored as pending audit and reported back as lower-confidence", async () => {
  const D1 = sqliteD1();
  const env = { DB: D1, INGEST_TOKEN: "t0k3n", REPORTER_HASH_SALT: "0123456789abcdef-salt" };
  const post = (body) => postReport({ request: new Request("https://x/api/reports", { method: "POST", headers: { authorization: "Bearer t0k3n", "content-type": "application/json" }, body: JSON.stringify(body) }), env });
  const a = await (await post({ channel: "web", handle: "h1", puCode: "24-09-05-012", race: "president", tally: T, evidence: "video" })).json();
  assert.deepEqual([a.evidence, a.audit, a.confidence], ["video", "pending", "lower"]);
  const b = await (await post({ channel: "web", handle: "h2", puCode: "24-09-05-012", race: "president", tally: T })).json();
  assert.deepEqual([b.evidence, b.audit], ["ec8a", undefined]);
  const rows = D1.db.prepare("SELECT evidence, audit_status FROM reports ORDER BY received_at, rowid").all().map((r) => `${r.evidence}:${r.audit_status}`);
  assert.deepEqual(rows.sort(), ["ec8a:null", "video:pending"]);
  assert.equal((await post({ channel: "web", handle: "h3", tally: T, evidence: "selfie" })).status, 422);
  assert.throws(() => D1.db.prepare("INSERT INTO reports (id, channel, reporter_hash, evidence) VALUES ('z', 'web', 'h', 'selfie')").run(), /CHECK/, "the database refuses unknown evidence types too");
});
