import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LGA_COUNT, puProblem, assessControls, ballotVerdict, BALLOT_CASES, postingGates, NOT_A_PARTY, STATUS_LABEL } from "../functions/_lib/ec8a.js";
import { parseReport } from "../functions/_lib/report.js";
import { INEC_STATE_CODE } from "../functions/_lib/results.js";
import { processUnit } from "../functions/_lib/pipeline.js";
import { reviewReading } from "../functions/_lib/review.js";
import { interpretOcr, readSheet, ocrReport } from "../functions/_lib/ocr.js";
import { parseOfficial } from "../functions/api/pipeline/official.js";
import { buildSnapshot, PRESS_NOTICE } from "../functions/api/press/snapshot.js";
import { onRequestPost as ingest } from "../functions/api/reports.js";
import { onRequestGet as config } from "../functions/api/config.js";
import { verifyChain, genesis } from "../functions/_lib/ledger.js";

// Session 88: closing the gaps of the 1 November 2026 production-readiness audit. Real SQLite with the real migrations.
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_ledger.sql", "0005_evidence.sql", "0006_media.sql", "0008_report_checks.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { db, prepare: (sql) => stmt(sql) };
}
const PU = "24-09-05-012", T = { APC: 47, PDP: 37, LP: 32, NNPP: 8 };          // valid 124
const GOOD = { register: 480, accredited: 130, rejected: 5 };                   // cast 129 ≤ 130 ≤ 480
let n = 0;
function add(D1, { pu = PU, tally = T, status = "needs_review", controls = GOOD, ok = null, evidence = "ec8a", media = null, face = null } = {}) {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  D1.db.prepare("INSERT INTO reports (id, channel, reporter_hash, pu_code, race, media_ref, tally_json, status, evidence, face_check) VALUES (?, 'web', ?, ?, 'president', ?, ?, ?, ?, ?)")
    .run(id, `h${n}`, pu, media, tally ? JSON.stringify(tally) : null, status, evidence, face);
  if (controls !== undefined && tally) {
    const balanced = ok ?? assessControls(controls, tally).ok;
    D1.db.prepare("INSERT INTO report_checks (report_id, controls_json, checks_ok) VALUES (?, ?, ?)").run(id, controls ? JSON.stringify(controls) : null, balanced ? 1 : 0);
  }
  return id;
}
const ledger = (D1) => D1.db.prepare("SELECT body_json FROM ledger_entries ORDER BY seq").all().map((r) => JSON.parse(r.body_json));
const LAGOS = { role: "szv", public_id: "V0007", states: ["NG-LA"], aal: "aal2" };
const NOTE = "Photo checked: every figure matches the sheet.";

test("polling-unit codes: positional check against the real LGA counts; 00-00-00-000 and 99-99-99-999 refused", () => {
  const states = Object.fromEntries(JSON.parse(readFileSync(new URL("../site/data/states.json", import.meta.url), "utf8")).states.map((s) => [s.iso, s.lgas]));
  for (const [code, iso] of Object.entries(INEC_STATE_CODE)) assert.equal(LGA_COUNT[code], states[iso], `LGA count for ${code} (${iso})`);
  assert.equal(Object.values(LGA_COUNT).reduce((a, b) => a + b, 0), 774);
  assert.equal(puProblem("24-09-05-012"), null);
  assert.equal(puProblem("37-06-01-001"), null, "FCT has 6 LGAs");
  assert.match(puProblem("37-07-01-001"), /does not exist/);
  assert.match(puProblem("00-00-00-000"), /not an INEC state/);
  assert.match(puProblem("99-99-99-999"), /not an INEC state/);
  assert.match(puProblem("24-09-00-012"), /ward/);
  assert.match(puProblem("24-09-05-000"), /unit/);
  assert.match(puProblem("24-9-5-12"), /must look like/);
});

test("void ballots are never a party; the six /vote/ cases classify; cancelled units carry no tally", () => {
  assert.deepEqual(BALLOT_CASES.map((c) => c.verdict), ["valid", "void", "void", "void", "void", "void"]);
  assert.equal(ballotVerdict({ marks: 1, boxes: 1 }), "valid");
  for (const c of [{ marks: 1, boxes: 2 }, { marks: 2, boxes: 2 }, { marks: 0, boxes: 0 }, { marks: 1, boxes: 1, identifies: true }, { marks: 1, boxes: 0, outside: true }]) assert.equal(ballotVerdict(c), "void");
  for (const k of ["VOID", "REJECTED", "SPOILT", "INVALID"]) assert.ok(NOT_A_PARTY.test(k));
  const voidParty = parseReport({ channel: "web", handle: "x", puCode: PU, tally: { APC: 3, VOID: 2 } });
  assert.equal(voidParty.ok, false);
  assert.match(voidParty.errors.join(), /not a party/);
  assert.equal(parseReport({ channel: "web", handle: "x", puCode: PU, tally: { APC: 3 }, controls: { cancelled: true } }).ok, false, "cancelled with a tally");
  assert.equal(parseReport({ channel: "web", handle: "x", puCode: PU, mediaRef: "m", controls: { cancelled: true } }).ok, true, "cancelled with no tally is fine");
  assert.equal(parseReport({ channel: "web", handle: "x", puCode: PU, tally: T, controls: { register: -1 } }).ok, false);
  assert.equal(parseReport({ channel: "web", handle: "x", puCode: PU, tally: T, controls: { weird: 1 } }).ok, false);
});

test("control totals: balanced, over-accredited, mismatched valid and cast, cancelled, missing", () => {
  assert.equal(assessControls(GOOD, T).ok, true);
  assert.match(assessControls({ ...GOOD, accredited: 120 }, T).errors.join(), /exceed accredited/);
  assert.match(assessControls({ ...GOOD, accredited: 500 }, T).errors.join(), /exceed the register/);
  assert.match(assessControls({ ...GOOD, valid: 125 }, T).errors.join(), /do not equal the party total/);
  assert.match(assessControls({ ...GOOD, cast: 130 }, T).errors.join(), /do not equal valid votes plus rejected/);
  assert.equal(assessControls({ cancelled: true }, null).ok, false);
  assert.equal(assessControls(null, T).present, false);
});

test("consensus: a needs_review reading no longer counts; only confirmed readings do", async () => {
  const D1 = sqliteD1();
  for (let i = 0; i < 3; i++) add(D1);
  const u = await processUnit(D1, PU, "president");
  assert.deepEqual([u.consensus.status, u.consensus.reports, ledger(D1).length], ["insufficient", 0, 0]);
  D1.db.prepare("UPDATE reports SET status = 'verified'").run();
  const v = await processUnit(D1, PU, "president");
  assert.deepEqual([v.consensus.status, ledger(D1).length, v.gates.score], ["high", 1, 100]);
  assert.deepEqual(ledger(D1)[0].gates.passed, ["polling-unit", "consensus", "human-or-confident", "control-totals", "baseline"]);
});

test("posting gates: an unbalanced sheet or a count above the register holds a high unit back, out of the totals", async () => {
  const D1 = sqliteD1();
  add(D1, { status: "verified" }); add(D1, { status: "verified" }); add(D1, { status: "verified", controls: { ...GOOD, register: 100 } });
  const held = await processUnit(D1, PU, "president");
  assert.deepEqual([held.consensus.status, ledger(D1).length], ["held", 0]);
  assert.deepEqual(held.gates.gates.filter((g) => !g.pass).map((g) => g.id), ["control-totals", "baseline"]);
  assert.equal(held.baseline.severity, "critical", "accredited and votes cast above the sheet's register");
  assert.equal(D1.db.prepare("SELECT COUNT(*) c FROM unit_consensus WHERE status = 'high'").get().c, 0, "the public totals read status high only");
  assert.equal(postingGates({ puCode: "00-00-00-000", consensus: { status: "high" }, counted: [{ checksOk: true }], baseline: null }).post, false);
});

test("IReV: a difference is stored, surfaced and does not block the citizen tally (constitution §4)", async () => {
  const D1 = sqliteD1();
  for (let i = 0; i < 3; i++) add(D1, { status: "verified" });
  D1.db.prepare("INSERT INTO official_results (pu_code, race, source, tally_json, document_url, fetched_at) VALUES (?, 'president', 'IReV', ?, 'https://inecelectionresults.ng/x', '2027-01-16T20:00:00Z')").run(PU, JSON.stringify({ ...T, PDP: 40 }));
  const u = await processUnit(D1, PU, "president");
  assert.equal(u.consensus.status, "high");
  assert.deepEqual(u.discrepancy, { match: false, diffs: [{ party: "PDP", citizen: 37, official: 40, delta: -3 }] });
  assert.deepEqual(ledger(D1)[0].discrepancy, u.discrepancy, "on the ledger entry");
  assert.ok(D1.db.prepare("SELECT discrepancy_json FROM unit_consensus").get().discrepancy_json.includes("PDP"));
  assert.deepEqual(parseOfficial({ puCode: PU, race: "president", tally: { APC: 1 }, documentUrl: "https://inecelectionresults.ng/doc" }).ok, true);
  for (const bad of [{ puCode: "99-99-99-999" }, { documentUrl: "http://x" }, { tally: { VOID: 3 } }, { race: "winner" }, { source: "Twitter" }])
    assert.equal(parseOfficial({ puCode: PU, race: "president", tally: { APC: 1 }, documentUrl: "https://inecelectionresults.ng/doc", ...bad }).ok, false, JSON.stringify(bad));
});

test("ledger: the chain still verifies and stays append-only after gated posts", async () => {
  const D1 = sqliteD1();
  for (const pu of ["24-09-05-012", "24-09-05-013"]) { for (let i = 0; i < 3; i++) add(D1, { pu, status: "verified" }); await processUnit(D1, pu, "president"); }
  const rows = D1.db.prepare("SELECT body_json FROM ledger_entries ORDER BY seq").all().map((r) => JSON.parse(r.body_json));
  assert.equal(rows.length, 2);
  assert.deepEqual(await verifyChain(rows, await genesis("ng-2027")), { ok: true, brokenAt: -1 });
});

test("verifier review: MFA, own state, confirm-or-reject only, must balance, once; three confirmations post the unit", async () => {
  const D1 = sqliteD1();
  const a = add(D1), b = add(D1), c = add(D1, { controls: null });
  assert.equal((await reviewReading(D1, { reportId: a, decision: "confirm", note: NOTE }, { ...LAGOS, aal: "aal1" })).status, 403, "needs MFA");
  assert.equal((await reviewReading(D1, { reportId: a, decision: "confirm", note: NOTE }, { ...LAGOS, states: ["NG-KN"] })).status, 403, "other state");
  assert.equal((await reviewReading(D1, { reportId: a, decision: "confirm", note: NOTE }, { ...LAGOS, role: "admin" })).status, 403, "OpsAdmin cannot");
  assert.equal((await reviewReading(D1, { reportId: a, decision: "edit", note: NOTE }, LAGOS)).status, 422);
  assert.equal((await reviewReading(D1, { reportId: a, decision: "confirm", note: "ok" }, LAGOS)).status, 422, "reason required");
  const unbalanced = await reviewReading(D1, { reportId: c, decision: "confirm", note: NOTE }, LAGOS);
  assert.equal(unbalanced.status, 422, "no totals: cannot confirm");
  assert.equal((await reviewReading(D1, { reportId: c, decision: "confirm", note: NOTE, controls: { register: 480, accredited: 100, rejected: 5 } }, LAGOS)).status, 422, "corrected totals still do not balance");
  assert.equal((await reviewReading(D1, { reportId: a, decision: "confirm", note: NOTE }, LAGOS)).body.unit.status, "low");
  assert.equal((await reviewReading(D1, { reportId: a, decision: "confirm", note: NOTE }, LAGOS)).status, 409, "once");
  await reviewReading(D1, { reportId: b, decision: "confirm", note: NOTE }, LAGOS);
  const last = await reviewReading(D1, { reportId: c, decision: "confirm", note: NOTE, controls: GOOD }, LAGOS);
  assert.deepEqual([last.status, last.body.unit.status, last.body.unit.posted], [200, "high", true]);
  const row = D1.db.prepare("SELECT status, audited_by, audit_note FROM reports WHERE id = ?").get(c);
  assert.deepEqual([row.status, row.audited_by, row.audit_note], ["verified", "V0007", NOTE]);
  const d = add(D1, { pu: "24-09-05-013" });
  assert.equal((await reviewReading(D1, { reportId: d, decision: "reject", note: NOTE }, LAGOS)).body.decision, "reject");
  assert.equal(D1.db.prepare("SELECT status FROM reports WHERE id = ?").get(d).status, "rejected");
  const alt = add(D1, { evidence: "board" });
  assert.equal((await reviewReading(D1, { reportId: alt, decision: "confirm", note: NOTE }, LAGOS)).status, 409, "alternatives are audited separately");
  assert.equal(STATUS_LABEL.needs_review, "Needs a verifier's check");
});

test("OCR: off by default, withheld without a cleared photo or on any error, and only ever a proposal", async () => {
  const good = JSON.stringify({ puCode: PU, parties: T, register: 480, accredited: 130, rejected: 5, confidence: { puCode: 0.95, parties: 0.97, register: 0.92, accredited: 0.95, rejected: 0.6 }, transcript: "APC 47 PDP 37 LP 32 NNPP 8" });
  const r = interpretOcr(`Here you go: ${good} done`);
  assert.deepEqual([r.status, r.tally, r.controls, r.low, r.confidence], ["proposed", T, { register: 480, accredited: 130, rejected: 5 }, ["rejected"], 0.6]);
  for (const bad of ["no json", "{}", JSON.stringify({ parties: { APC: 1.5 } }), JSON.stringify({ parties: { "A-1": 3 } })]) assert.equal(interpretOcr(bad).status, "withheld", bad);
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal((await readSheet({}, { bytes, faceCheck: "none" })).status, "off");
  const ai = { run: async () => ({ response: good }) };
  assert.equal((await readSheet({ OCR_ENGINE: "workers-ai", AI: ai }, { bytes, faceCheck: "unchecked" })).status, "withheld", "no AI sees an uncleared photo");
  assert.equal((await readSheet({ OCR_ENGINE: "workers-ai", AI: { run: async () => { throw new Error("boom"); } } }, { bytes, faceCheck: "none" })).status, "withheld");
  const ok = await readSheet({ OCR_ENGINE: "workers-ai", AI: ai }, { bytes, faceCheck: "none" });
  assert.deepEqual([ok.status, ok.aiGenerated, ok.inputSha256.length], ["proposed", true, 64]);

  const D1 = sqliteD1();
  const id = add(D1, { tally: null, status: "ocr_pending", media: "r2:full/x.jpg", face: "none" });
  const env = { DB: D1, OCR_ENGINE: "workers-ai", AI: ai, EVIDENCE: { get: async () => ({ httpMetadata: { contentType: "image/jpeg" }, arrayBuffer: async () => bytes.buffer }) } };
  const out = await ocrReport(env, id, { assessControls });
  assert.deepEqual([out.status, out.body.ocr, out.body.proposalFilled], [200, "proposed", true]);
  const rep = D1.db.prepare("SELECT status, tally_json FROM reports WHERE id = ?").get(id);
  assert.deepEqual([rep.status, JSON.parse(rep.tally_json)], ["needs_review", T], "a proposal waits for a verifier");
  assert.equal((await processUnit(D1, PU, "president")).consensus.reports, 0, "and does not count");
  const off = await ocrReport({ DB: D1, OCR_ENGINE: "off" }, id, { assessControls });
  assert.equal(off.body.ocr, "off");
});

test("ingest: the sheet check is stored with the report; bad codes and void parties are refused", async () => {
  const D1 = sqliteD1();
  const env = { DB: D1, INGEST_TOKEN: "t", REPORTER_HASH_SALT: "s".repeat(32) };
  const post = (body) => ingest({ request: new Request("https://x/api/reports", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) }), env });
  const ok = await post({ channel: "web", handle: "a", puCode: PU, race: "president", tally: T, controls: GOOD });
  const j = await ok.json();
  assert.deepEqual([ok.status, j.controls.balanced], [201, true]);
  assert.equal(D1.db.prepare("SELECT checks_ok FROM report_checks WHERE report_id = ?").get(j.id).checks_ok, 1);
  const bad = await (await post({ channel: "web", handle: "b", puCode: PU, race: "president", tally: T, controls: { ...GOOD, accredited: 10 } })).json();
  assert.equal(bad.controls.balanced, false);
  assert.equal((await post({ channel: "web", handle: "c", puCode: "00-00-00-000", race: "president", tally: T })).status, 422);
  assert.equal((await post({ channel: "web", handle: "c", puCode: PU, race: "president", tally: { APC: 1, REJECTED: 4 } })).status, 422);
});

test("press snapshot: aggregates only, no personal or evidence keys, held and lower units out of the totals", () => {
  const units = [
    { pu_code: PU, status: "high", tally: T, irev: { match: false, diffs: [] } },
    { pu_code: "24-09-05-013", status: "held", tally: { APC: 900 } },
    { pu_code: "24-09-05-014", status: "lower", tally: { APC: 500 } },
    { pu_code: "24-09-05-015", status: "medium", tally: null },
  ];
  const s = buildSnapshot("president", units, { seq: 7, hash: "ab".repeat(32) });
  assert.equal(s.notice, PRESS_NOTICE);
  assert.deepEqual(s.national.totals, T);
  assert.deepEqual([s.units.published, s.units.held, s.units.lowerConfidence, s.units.notYetHigh], [1, 1, 1, 1]);
  assert.deepEqual(s.irev, { compared: 1, mismatches: 1 });
  const text = JSON.stringify(s);
  for (const key of ["reporter", "hash\":\"h", "media", "caption", "photo", "public_id", "audited_by", "email", "handle", "leader", "winner"]) assert.ok(!text.includes(key), key);
});

test("config no longer says whether a service role is configured", async () => {
  const j = await (await config({ env: { SUPABASE_SERVICE_ROLE_KEY: "x" } })).json();
  assert.ok(!("adminDecisions" in j));
});
