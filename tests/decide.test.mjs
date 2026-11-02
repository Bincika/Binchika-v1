import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { onRequestPost } from "../functions/api/admin/decide.js";

// Session 76: a correction needs three separate seats (raiser, a different NRV, the approving BinchikAdmin).
// Supabase is stubbed at fetch level; D1 is a real SQLite database with the real migrations.
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_ledger.sql", "0005_evidence.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
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

async function decide(flag, { approverId = "V0001", decision = "approve" } = {}) {
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
    const env = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", DB };
    const request = new Request("https://binchika.com/api/admin/decide", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ flagId: FLAG_ID, decision, note: "AI re-check matches the photos." }),
    });
    const r = await onRequestPost({ request, env });
    const ledger = DB.db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE kind = 'correction'").get().c;
    return { status: r.status, body: await r.json(), patches, ledger };
  } finally { globalThis.fetch = realFetch; }
}
const flag = (o) => ({ id: FLAG_ID, pu_code: "24-09-05-012", race: "president", status: "escalated", proposed_tally: { APC: 90, PDP: 95 }, raised_by_public_id: "V0042", nrv_public_id: "V0130", ...o });

test("three separate seats: the correction is written", async () => {
  const r = await decide(flag());
  assert.equal(r.status, 200);
  assert.equal(r.ledger, 1);
  assert.equal(r.patches[0].status, "approved");
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
