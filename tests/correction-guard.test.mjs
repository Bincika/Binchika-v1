import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestPost as decideRoute } from "../functions/api/admin/decide.js";
import * as conflictsRoute from "../functions/api/admin/correction-conflicts.js";
import { processUnit, appendEntry } from "../functions/_lib/pipeline.js";
import { isClaimClash } from "../functions/_lib/correction-guard.js";
import { assessControls } from "../functions/_lib/ec8a.js";
import { verifyChain, genesis } from "../functions/_lib/ledger.js";
import { sqliteD1, CORRECTION_GUARD_SCHEMA, CORRECTION_GUARD_BACKFILL } from "./fixtures/correction-guard-schema.mjs";

// Build plan 8 (docs/CORRECTION-PATH-BUILD-PLAN.md, sections 5, 7 and 11). Session 211 builds the code that refuses
// corrections safely until the migration exists; the migration file itself is not written (owner). Supabase is stubbed at
// fetch level; D1 is real SQLite with the real migrations plus the plan's schema as a test fixture.
const PU = "24-09-05-012", RACE = "president";
const T = { PA: 47, PB: 37, PC: 32, PD: 8 };            // what the sheets say; valid 124
const C = { PA: 37, PB: 47, PC: 32, PD: 8 };            // a different, approved correction
const GOOD = { register: 480, accredited: 130, rejected: 5 };
const FLAG_1 = "11111111-2222-3333-4444-555555555555", FLAG_2 = "66666666-7777-8888-9999-000000000000";
const ADMIN_EMAIL = "admin@example.org";                   // public in the brief; its hash is the BinchikAdmin lock
const token = `x.${Buffer.from(JSON.stringify({ aal: "aal2" })).toString("base64url")}.y`;

let n = 0;
function addReport(D1, tally = T) {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  D1.db.prepare("INSERT INTO reports (id, channel, reporter_hash, pu_code, race, tally_json, status, evidence) VALUES (?, 'web', ?, ?, ?, ?, 'verified', 'ec8a')")
    .run(id, `h${n}`, PU, RACE, JSON.stringify(tally));
  D1.db.prepare("INSERT INTO report_checks (report_id, controls_json, checks_ok) VALUES (?, ?, ?)").run(id, JSON.stringify(GOOD), assessControls(GOOD, tally).ok ? 1 : 0);
  return id;
}
/** Three confirmed sheets, then the real pipeline posts the unit. */
async function postedUnit(D1) {
  for (let i = 0; i < 3; i++) addReport(D1);
  const u = await processUnit(D1, PU, RACE);
  assert.equal(u.consensus.status, "high");
  return u.ledgerEntry;
}
const flag = (o = {}) => ({ id: FLAG_1, pu_code: PU, race: RACE, status: "escalated", proposed_tally: C, raised_by_public_id: "V0042", nrv_public_id: "V0130", ...o });

/** Supabase stub. flagStatus: what the conditional PATCH and the admin list see. patchRows: what the PATCH returns. */
function stubSupabase({ flags = {}, patchRows = null } = {}) {
  const calls = { patches: [], patchUrls: [] };
  const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    if (u.endsWith("/auth/v1/user")) return ok({ id: "u-admin", email: ADMIN_EMAIL });
    if (u.includes("/rest/v1/verifiers?")) return ok([{ role: "superadmin", public_id: "V0001" }]);
    if (u.includes("/rest/v1/discrepancy_flags?") && init.method === "PATCH") {
      calls.patches.push(JSON.parse(init.body)); calls.patchUrls.push(u);
      const id = /id=eq\.([0-9a-f-]{36})/.exec(u)[1];
      return ok(patchRows ?? (flags[id] ? [{ id }] : []));
    }
    if (u.includes("/rest/v1/discrepancy_flags?id=eq.")) {
      const id = /id=eq\.([0-9a-f-]{36})/.exec(u)[1];
      return ok(flags[id] ? [flags[id]] : []);
    }
    if (u.includes("/rest/v1/discrepancy_flags?id=in.")) {
      const ids = /id=in\.\(([^)]*)\)/.exec(u)[1].split(",");
      return ok(ids.filter((id) => flags[id]).map((id) => ({ id, status: flags[id].status })));
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}
const env = (DB) => ({ SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", DB });
async function decide(DB, f, { decision = "approve", supa = {} } = {}) {
  const realFetch = globalThis.fetch;
  const calls = stubSupabase({ flags: { [f.id]: f, ...(supa.flags ?? {}) }, patchRows: supa.patchRows });
  try {
    const request = new Request("https://binchika.com/api/admin/decide", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ flagId: f.id, decision, note: "AI re-check matches the photos." }),
    });
    const r = await decideRoute({ request, env: env(DB) });
    return { status: r.status, body: await r.json(), ...calls };
  } finally { globalThis.fetch = realFetch; }
}
async function adminList(DB, flags = {}) {
  const realFetch = globalThis.fetch;
  stubSupabase({ flags });
  try {
    const request = new Request("https://binchika.com/api/admin/correction-conflicts", { headers: { authorization: `Bearer ${token}` } });
    const r = await conflictsRoute.onRequestGet({ request, env: env(DB) });
    return { status: r.status, body: await r.json() };
  } finally { globalThis.fetch = realFetch; }
}
const count = (D1, sql) => D1.db.prepare(sql).get().c;
const corrections = (D1) => count(D1, "SELECT COUNT(*) c FROM ledger_entries WHERE kind = 'correction'");
const tallies = (D1) => count(D1, "SELECT COUNT(*) c FROM ledger_entries WHERE kind = 'tally'");
const claims = (D1) => count(D1, "SELECT COUNT(*) c FROM correction_claims");
const conflicts = (D1, open = true) => count(D1, `SELECT COUNT(*) c FROM correction_conflicts${open ? " WHERE resolved_at IS NULL" : ""}`);
const unit = (D1) => D1.db.prepare("SELECT * FROM unit_consensus WHERE pu_code = ? AND race = ?").get(PU, RACE);
const chain = (D1) => D1.db.prepare("SELECT body_json FROM ledger_entries ORDER BY seq").all().map((r) => JSON.parse(r.body_json));
async function corrected(D1, f = flag()) {
  await postedUnit(D1);
  const r = await decide(D1, f);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}

test("1. double approval: the second approval of one flag is refused; one correction entry, one claim", async () => {
  const D1 = sqliteD1();
  await corrected(D1);
  const again = await decide(D1, flag(), { supa: { patchRows: [] } });   // the flag PATCH changes nothing: it is approved
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already been decided/);
  assert.equal(corrections(D1), 1);
  assert.equal(claims(D1), 1);
});

test("2. the batch rolls back: a seq clash on every attempt leaves no claim, no entry and an unchanged unit", async () => {
  const D1 = sqliteD1();
  await postedUnit(D1);
  const before = unit(D1);
  D1.db.exec("CREATE TRIGGER t_force BEFORE INSERT ON ledger_entries WHEN NEW.kind = 'correction' BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: ledger_entries.seq'); END;");
  const r = await decide(D1, flag());
  assert.equal(r.status, 503);
  assert.match(r.body.error, /busy/);
  assert.equal(corrections(D1), 0);
  assert.equal(claims(D1), 0);
  assert.deepEqual(unit(D1), before);
  assert.equal(r.patches.length, 0, "the flag is left as it was");
});

test("3. check, then write: the unit is held between the route's read and the batch; refused, nothing written", async () => {
  let armed = true;
  const D1 = sqliteD1({ hooks: { afterFirst: (sql, db) => {
    if (armed && /SELECT status, ledger_hash FROM unit_consensus/.test(sql)) { armed = false; db.db.exec("UPDATE unit_consensus SET status = 'held'"); }
  } } });
  await postedUnit(D1);
  armed = true;
  const r = await decide(D1, flag());
  assert.equal(r.status, 409);
  assert.match(r.body.error, /changed while you were deciding/);
  assert.equal(corrections(D1), 0);
  assert.equal(claims(D1), 0);
  assert.equal(unit(D1).status, "held");
  assert.equal(r.patches.length, 0);
});

test("4. contention: another entry lands between the head read and the batch; one correction on the new head; the chain verifies", async () => {
  let armed = false;
  const D1 = sqliteD1({ hooks: { beforeBatch: async (stmts, db) => {
    if (armed && stmts.some((s) => /INSERT INTO correction_claims/.test(s.sql))) {
      armed = false;
      await appendEntry(db, { kind: "tally", pu_code: "24-09-05-013", race: RACE, tally: { PA: 1 } });
    }
  } } });
  await postedUnit(D1);
  armed = true;
  const r = await decide(D1, flag());
  assert.equal(r.status, 200);
  assert.equal(corrections(D1), 1);
  const entries = chain(D1);
  assert.equal(entries.length, 3);
  assert.equal(entries[2].kind, "correction", "the correction sits on the new head");
  assert.deepEqual(await verifyChain(entries, await genesis("example-2099")), { ok: true, brokenAt: -1 });
});

test("5. the flag PATCH changes nothing: 200 with a warning; claim and entry stand; the admin list shows it unreconciled", async () => {
  const D1 = sqliteD1();
  await postedUnit(D1);
  const r = await decide(D1, flag(), { supa: { patchRows: [] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.warning, "flag already updated");
  assert.match(r.patchUrls[0], /status=in\.\(escalated,investigating,ai_done\)/, "the PATCH is conditional");
  assert.equal(corrections(D1), 1);
  assert.equal(claims(D1), 1);
  const list = await adminList(D1, { [FLAG_1]: { status: "escalated" } });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.unreconciled.map((c) => c.flag_id), [FLAG_1]);
  assert.deepEqual(Object.keys(list.body.unreconciled[0]).sort(), ["created_at", "flag_id", "flag_status", "ledger_hash", "pu_code", "race"], "no person in the list");
});

test("6. a recompute after a correction with the same tally (keys in another order): no new entry, no conflict", async () => {
  const D1 = sqliteD1();
  const same = { PD: 8, PC: 32, PB: 37, PA: 47 };
  await corrected(D1, flag({ proposed_tally: same }));
  const before = chain(D1).length;
  const u = await processUnit(D1, PU, RACE);
  assert.equal(u.ledgerEntry, null);
  assert.equal(chain(D1).length, before);
  assert.equal(conflicts(D1, false), 0);
  assert.equal(unit(D1).correction_hash, unit(D1).ledger_hash);
});

test("7. a recompute after a correction with a different tally: no tally entry; the correction stands; one conflict, once", async () => {
  const D1 = sqliteD1();
  await corrected(D1);
  const before = unit(D1);
  const u = await processUnit(D1, PU, RACE);
  assert.equal(u.correctionConflict, true);
  assert.equal(u.ledgerEntry, null);
  assert.equal(tallies(D1), 1, "only the original post");
  assert.deepEqual(unit(D1), before, "status, tally, hashes, discrepancy and updated_at are all unchanged");
  assert.equal(JSON.parse(unit(D1).tally_json).PA, C.PA);
  assert.equal(conflicts(D1), 1);
  await processUnit(D1, PU, RACE);
  assert.equal(conflicts(D1, false), 1, "the same conflict is recorded once");
});

test("8. a recompute after a correction that falls below high: the unit stays posted with the correction; one conflict", async () => {
  const D1 = sqliteD1();
  await corrected(D1, flag({ proposed_tally: T }));
  D1.db.exec("UPDATE reports SET status = 'rejected' WHERE id IN (SELECT id FROM reports LIMIT 2)");
  const u = await processUnit(D1, PU, RACE);
  assert.equal(u.correctionConflict, true);
  assert.equal(unit(D1).status, "high");
  assert.equal(unit(D1).correction_hash, unit(D1).ledger_hash);
  assert.equal(conflicts(D1), 1);
  assert.notEqual(D1.db.prepare("SELECT recomputed_status s FROM correction_conflicts").get().s, "high");
});

test("9. a new correction supersedes the old one and resolves the unit's open conflicts", async () => {
  const D1 = sqliteD1();
  const first = await corrected(D1);
  await processUnit(D1, PU, RACE);                     // the sheets disagree with the correction: one open conflict
  assert.equal(conflicts(D1), 1);
  const r = await decide(D1, flag({ id: FLAG_2, proposed_tally: T }));
  assert.equal(r.status, 200);
  const last = chain(D1).at(-1);
  assert.equal(last.supersedes, first.body.ledger.hash);
  assert.equal(unit(D1).correction_hash, r.body.ledger.hash);
  assert.equal(conflicts(D1), 0);
  assert.equal(D1.db.prepare("SELECT resolved_by_hash h FROM correction_conflicts").get().h, r.body.ledger.hash);
});

test("10. the real migration file 0011 on a copy: applies cleanly; its backfill marks only units whose latest entry is a correction; 0 rows on an empty ledger; nothing else changes", async () => {
  const empty = sqliteD1({ guard: false });
  empty.db.exec(CORRECTION_GUARD_SCHEMA);
  assert.equal(Number(empty.db.prepare(CORRECTION_GUARD_BACKFILL).run().changes), 0, "an empty ledger: the backfill changes nothing");
  for (const t of ["correction_claims", "correction_conflicts"]) assert.ok(empty.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  assert.ok(empty.db.prepare("SELECT 1 FROM pragma_table_info('unit_consensus') WHERE name = 'correction_hash'").get());

  const D1 = sqliteD1({ guard: false });                // the old code writes a tally and a correction, then the migration arrives
  for (const pu of [PU, "24-09-05-013"]) {
    const e = await appendEntry(D1, { kind: "tally", pu_code: pu, race: RACE, tally: T });
    D1.db.prepare("INSERT INTO unit_consensus (pu_code, race, status, share, reports, tally_json, ledger_hash) VALUES (?, ?, 'high', 1, 3, ?, ?)").run(pu, RACE, JSON.stringify(T), e.hash);
  }
  const c = await appendEntry(D1, { kind: "correction", pu_code: PU, race: RACE, tally: C });
  const ledgerBefore = D1.db.prepare("SELECT * FROM ledger_entries ORDER BY seq").all();
  const unitsBefore = D1.db.prepare("SELECT * FROM unit_consensus ORDER BY pu_code").all().map((r) => ({ ...r }));
  D1.db.exec(CORRECTION_GUARD_SCHEMA);                  // the whole file, backfill included
  const marked = () => D1.db.prepare("SELECT pu_code, correction_hash FROM unit_consensus ORDER BY pu_code").all().map((r) => [r.pu_code, r.correction_hash]);
  assert.deepEqual(marked(), [[PU, c.hash], ["24-09-05-013", null]]);
  D1.db.prepare(CORRECTION_GUARD_BACKFILL).run();       // re-run after the deploy (Gate 1, N1): same result
  assert.deepEqual(marked(), [[PU, c.hash], ["24-09-05-013", null]]);
  assert.deepEqual(D1.db.prepare("SELECT * FROM ledger_entries ORDER BY seq").all(), ledgerBefore, "the ledger is untouched");
  assert.deepEqual(D1.db.prepare("SELECT * FROM unit_consensus ORDER BY pu_code").all().map(({ correction_hash, ...r }) => r), unitsBefore, "no other unit column changes");
  assert.throws(() => D1.db.exec("UPDATE ledger_entries SET kind = 'tally'"), /append-only/, "the ledger triggers still hold");
});

test("11. before the migration (production as it is today): approve 503, nothing written; reject works; processUnit as today; admin list 503", async () => {
  const D1 = sqliteD1({ guard: false });
  await postedUnit(D1);
  assert.equal(tallies(D1), 1, "processUnit posts exactly as today");
  const before = unit(D1);
  const r = await decide(D1, flag());
  assert.equal(r.status, 503);
  assert.match(r.body.error, /corrections are being upgraded/);
  assert.equal(corrections(D1), 0);
  assert.deepEqual(unit(D1), before);
  assert.equal(r.patches.length, 0, "the flag is left as it was");
  const rej = await decide(D1, flag(), { decision: "reject" });
  assert.equal(rej.status, 200);
  assert.equal(rej.patches[0].status, "rejected");
  D1.db.exec("UPDATE reports SET status = 'rejected'");
  for (let i = 0; i < 3; i++) addReport(D1, C);
  const u = await processUnit(D1, PU, RACE);             // the sheets now say C: today's path appends a new tally entry
  assert.equal(u.correctionConflict, undefined);
  assert.equal(u.consensus.status, "high");
  assert.equal(tallies(D1), 2);
  assert.equal((await adminList(D1)).status, 503);
});

test("12. F1: a claim clash is told apart from a seq or hash clash, in SQLite's words and D1's", () => {
  assert.equal(isClaimClash(new Error("UNIQUE constraint failed: correction_claims.flag_id")), true);
  assert.equal(isClaimClash(new Error("D1_ERROR: UNIQUE constraint failed: correction_claims.flag_id: SQLITE_CONSTRAINT")), true);
  assert.equal(isClaimClash(new Error("UNIQUE constraint failed: ledger_entries.seq")), false);
  assert.equal(isClaimClash(new Error("D1_ERROR: UNIQUE constraint failed: ledger_entries.hash: SQLITE_CONSTRAINT")), false);
});

test("13. F3: a correction commits between processUnit's read and its write; the recount does not override it", async () => {
  let armed = false, db = null;
  const D1 = sqliteD1({ hooks: { afterFirst: async (sql) => {
    if (armed && /SELECT tally_json, status, ledger_hash, correction_hash FROM unit_consensus/.test(sql)) {
      armed = false;
      const r = await decide(db, flag());
      assert.equal(r.status, 200);
    }
  } } });
  db = D1;
  await postedUnit(D1);
  armed = true;
  const u = await processUnit(D1, PU, RACE);
  assert.equal(u.correctionConflict, true);
  assert.equal(tallies(D1), 1, "no tally entry over the correction");
  assert.equal(unit(D1).correction_hash, unit(D1).ledger_hash);
  assert.equal(JSON.parse(unit(D1).tally_json).PA, C.PA);
});

test("14. F5: the D1 write committed but the flag PATCH failed; approving again updates the flag only", async () => {
  const D1 = sqliteD1();
  await postedUnit(D1);
  const realFetch = globalThis.fetch;
  stubSupabase({ flags: { [FLAG_1]: flag() } });
  const failing = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (init.method === "PATCH" ? new Response("{}", { status: 500 }) : failing(url, init));
  try {
    const request = new Request("https://binchika.com/api/admin/decide", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ flagId: FLAG_1, decision: "approve", note: "AI re-check matches the photos." }),
    });
    await assert.rejects(decideRoute({ request, env: env(D1) }));
  } finally { globalThis.fetch = realFetch; }
  assert.equal(corrections(D1), 1);
  const entries = chain(D1).length;
  const r = await decide(D1, flag());
  assert.equal(r.status, 200);
  assert.equal(r.body.warning, "flag updated on retry");
  assert.equal(r.patches[0].status, "approved");
  assert.equal(chain(D1).length, entries, "nothing new in D1");
  assert.equal(claims(D1), 1);
});

test("15. N2: a stale correction_hash (not the unit's ledger_hash) counts as uncorrected; today's behaviour", async () => {
  const D1 = sqliteD1();
  await postedUnit(D1);
  D1.db.prepare("UPDATE unit_consensus SET correction_hash = 'stale'").run();
  D1.db.exec("UPDATE reports SET status = 'rejected'");
  for (let i = 0; i < 3; i++) addReport(D1, C);
  const u = await processUnit(D1, PU, RACE);
  assert.equal(u.correctionConflict, undefined);
  assert.equal(conflicts(D1, false), 0);
  assert.equal(tallies(D1), 2, "a tally entry exactly as today");
  assert.equal(JSON.parse(unit(D1).tally_json).PA, C.PA);
});
