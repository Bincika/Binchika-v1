import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { onRequestPost } from "../functions/api/admin/decide.js";
import { appendEntry } from "../functions/_lib/pipeline.js";
import { checkTally, parseReport } from "../functions/_lib/report.js";

// Session 76: a correction needs three separate seats (raiser, a different NRV, the approving BinchikAdmin).
// Supabase is stubbed at fetch level; D1 is a real SQLite database with the real migrations.
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

const FLAG_ID = "11111111-2222-3333-4444-555555555555";
// The owner's address is already public in the project brief; its hash is the BinchikAdmin lock.
const ADMIN_EMAIL = "admin@example.org";
const token = `x.${Buffer.from(JSON.stringify({ aal: "aal2" })).toString("base64url")}.y`;

async function decide(flag, { approverId = "V0001", decision = "approve", seed = posted } = {}) {
  const patches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (u.endsWith("/auth/v1/user")) return ok({ id: "u-admin", email: ADMIN_EMAIL });
    if (u.includes("/rest/v1/verifiers?")) return ok([{ role: "superadmin", public_id: approverId }]);
    if (u.includes("/rest/v1/discrepancy_flags?") && (init.method ?? "GET") === "GET") return ok([flag]);
    if (u.includes("/rest/v1/discrepancy_flags?") && init.method === "PATCH") { patches.push(JSON.parse(init.body)); return ok([]); }
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const DB = sqliteD1();
    if (seed) await seed(DB);
    const env = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", DB };
    const request = new Request("https://binchika.com/api/admin/decide", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ flagId: FLAG_ID, decision, note: "AI re-check matches the photos." }),
    });
    const r = await onRequestPost({ request, env });
    const ledger = DB.db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE kind = 'correction'").get().c;
    const unit = DB.db.prepare("SELECT status, ledger_hash FROM unit_consensus WHERE pu_code = ?1 AND race = ?2").get("24-09-05-012", "president") ?? null;
    const last = DB.db.prepare("SELECT body_json AS body FROM ledger_entries WHERE kind = 'correction' ORDER BY seq DESC LIMIT 1").get();
    return { status: r.status, body: await r.json(), patches, ledger, unit, correction: last ? JSON.parse(last.body) : null };
  } finally { globalThis.fetch = realFetch; }
}
// Session 196 (build-plan-6): a correction may change only a posted result. "Posted" = status high with a ledger hash.
const unitRow = (DB, status, hash) => DB.db.prepare(
  "INSERT INTO unit_consensus (pu_code, race, status, share, reports, tally_json, ledger_hash) VALUES ('24-09-05-012', 'president', ?1, 0.9, 3, ?2, ?3)",
).run(status, JSON.stringify({ PA: 95, PB: 90 }), hash);
async function posted(DB) {
  const e = await appendEntry(DB, { kind: "tally", pu_code: "24-09-05-012", race: "president", tally: { PA: 95, PB: 90 } });
  unitRow(DB, "high", e.hash);
  return e;
}
let postedHash = null;
const postedRemember = async (DB) => { postedHash = (await posted(DB)).hash; };
const flag = (o) => ({ id: FLAG_ID, pu_code: "24-09-05-012", race: "president", status: "escalated", proposed_tally: { PA: 90, PB: 95 }, raised_by_public_id: "V0042", nrv_public_id: "V0130", ...o });

test("three separate seats: the correction is written", async () => {
  const r = await decide(flag(), { seed: postedRemember });
  assert.equal(r.status, 200);
  assert.equal(r.ledger, 1);
  assert.equal(r.patches[0].status, "approved");
  assert.equal(r.unit.status, "high");
  assert.ok(postedHash && r.correction.supersedes === postedHash, "the correction points at the posted entry it replaces");
});

test("a held unit cannot be posted by an approved correction", async () => {
  const r = await decide(flag(), { seed: (DB) => unitRow(DB, "held", null) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not on the ledger/);
  assert.equal(r.ledger, 0);
  assert.equal(r.patches.length, 0, "the flag is left as it was, so it can still be rejected");
  assert.equal(r.unit.status, "held");
  assert.equal(r.unit.ledger_hash, null);
});

test("a unit with no consensus row cannot be posted by a correction", async () => {
  const r = await decide(flag(), { seed: null });
  assert.equal(r.status, 409);
  assert.equal(r.ledger, 0);
  assert.equal(r.patches.length, 0);
  assert.equal(r.unit, null);
});

test("a unit held after it was posted (old hash kept) cannot be re-posted by a correction", async () => {
  const r = await decide(flag(), { seed: async (DB) => { await posted(DB); DB.db.exec("UPDATE unit_consensus SET status = 'held'"); } });
  assert.equal(r.status, 409);
  assert.equal(r.ledger, 0);
  assert.equal(r.unit.status, "held");
});

test("no Regional Verifier on the flag (e.g. escalated by the admin alone): refused, nothing written", async () => {
  const r = await decide(flag({ nrv_public_id: null }));
  assert.equal(r.status, 409);
  assert.equal(r.ledger, 0);
  assert.equal(r.patches.length, 0);
});

test("an NRV escalating their own flag: refused", async () => {
  const r = await decide(flag({ raised_by_public_id: "V0130", nrv_public_id: "V0130" }));
  assert.equal(r.status, 409);
  assert.equal(r.ledger, 0);
});

test("the approver raised the flag: refused", async () => {
  const r = await decide(flag({ raised_by_public_id: "V0001" }));
  assert.equal(r.status, 409);
  assert.equal(r.ledger, 0);
});

test("rejecting still works without the three-seat rule (it changes nothing in the ledger)", async () => {
  const r = await decide(flag({ nrv_public_id: null }), { decision: "reject" });
  assert.equal(r.status, 200);
  assert.equal(r.ledger, 0);
  assert.equal(r.patches[0].status, "rejected");
});

// Session 200 (build-plan-7): a correction's figures are checked before anything is written.
const sheet = (register) => (DB) => {
  DB.db.prepare("INSERT INTO reports (id, channel, reporter_hash, pu_code, race, tally_json, status, evidence) VALUES ('r1','web','h1','24-09-05-012','president','{\"PA\":90,\"PB\":95}','verified','ec8a')").run();
  DB.db.prepare("INSERT INTO report_checks (report_id, controls_json, checks_ok) VALUES ('r1', ?1, 1)").run(JSON.stringify({ register }));
};
const postedWithSheet = (register) => async (DB) => { await posted(DB); sheet(register)(DB); };
const refusedUnchanged = (r, status) => {
  assert.equal(r.status, status);
  assert.equal(r.ledger, 0);
  assert.equal(r.patches.length, 0, "the flag is left as it was");
  assert.equal(r.unit.status, "high");
};

test("a correction with negative votes is refused", async () => {
  refusedUnchanged(await decide(flag({ proposed_tally: { PA: -5, PB: 95 } })), 422);
});

test("a correction with fractional votes is refused", async () => {
  refusedUnchanged(await decide(flag({ proposed_tally: { PA: 90.5, PB: 95 } })), 422);
});

test("a correction that puts votes in a non-party (VOID) is refused", async () => {
  const r = await decide(flag({ proposed_tally: { PA: 90, VOID: 4 } }));
  refusedUnchanged(r, 422);
  assert.match(r.body.error, /VOID/);
});

test("a correction given as an array or an empty object is refused", async () => {
  refusedUnchanged(await decide(flag({ proposed_tally: [90, 95] })), 422);
  refusedUnchanged(await decide(flag({ proposed_tally: {} })), 422);
});

test("a correction whose votes exceed the register printed on the unit's sheets is refused", async () => {
  const r = await decide(flag({ proposed_tally: { PA: 90, PB: 95 } }), { seed: postedWithSheet(150) });
  refusedUnchanged(r, 409);
  assert.match(r.body.error, /register/);
});

test("a correction within the register is written, with party keys upper-cased", async () => {
  const r = await decide(flag({ proposed_tally: { pa: 90, PB: 95 } }), { seed: postedWithSheet(300) });
  assert.equal(r.status, 200);
  assert.equal(r.ledger, 1);
  assert.deepEqual(r.correction.tally, { PA: 90, PB: 95 });
});

test("the correction check and intake refuse the same bad party and the same bad figure", () => {
  for (const tally of [{ VOID: 3 }, { PA: -1 }, { PA: 1.5 }, { "A-B": 2 }]) {
    assert.ok(checkTally(tally).errors.length > 0, JSON.stringify(tally));
    assert.ok(!parseReport({ channel: "web", handle: "h", puCode: "24-09-05-012", race: "president", tally }).ok, JSON.stringify(tally));
  }
  assert.deepEqual(checkTally({ pa: 1 }), { value: { PA: 1 }, errors: [] });
});
