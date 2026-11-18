import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { processUnit } from "../functions/_lib/pipeline.js";
import { onRequestPost as decideRoute } from "../functions/api/admin/decide.js";
import { appendEntry } from "../functions/_lib/pipeline.js";
import { assessControls } from "../functions/_lib/ec8a.js";
import { sqliteD1 } from "./fixtures/correction-guard-schema.mjs";

// Session 215: constitution §4 (amended 18 November 2026): "A machine reading (OCR) never counts by itself ... only a
// verifier's confirmation makes a photo read." The counting path for status "ocr_done" is removed from processUnit and
// from the correction route's register check. OCR stays off (OCR_ENGINE "off"); this changes nothing live.
const PU = "24-09-05-012", RACE = "president";
const T = { PA: 47, PB: 37, PC: 32, PD: 8 };
const GOOD = { register: 480, accredited: 130, rejected: 5 };
let n = 0;
function sheet(D1, status, { register = GOOD.register } = {}) {
  const id = `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
  D1.db.prepare("INSERT INTO reports (id, channel, reporter_hash, pu_code, race, tally_json, status, evidence) VALUES (?, 'web', ?, ?, ?, ?, ?, 'ec8a')")
    .run(id, `m${n}`, PU, RACE, JSON.stringify(T), status);
  const controls = { ...GOOD, register };
  D1.db.prepare("INSERT INTO report_checks (report_id, controls_json, checks_ok) VALUES (?, ?, ?)").run(id, JSON.stringify(controls), assessControls(controls, T).ok ? 1 : 0);
  return id;
}
const entries = (D1) => D1.db.prepare("SELECT COUNT(*) c FROM ledger_entries").get().c;

for (const guard of [false, true]) {
  const label = guard ? "with the correction guard" : "before the correction guard";
  test(`a machine reading never counts by itself: three agreeing "ocr_done" sheets post nothing (${label})`, async () => {
    const D1 = sqliteD1({ guard });
    for (let i = 0; i < 3; i++) sheet(D1, "ocr_done");
    const u = await processUnit(D1, PU, RACE);
    assert.equal(u.consensus.reports, 0, "no machine reading is counted");
    assert.notEqual(u.consensus.status, "high");
    assert.equal(entries(D1), 0, "nothing reaches the ledger");
  });

  test(`only a person's confirmation makes a sheet count: the same sheets, confirmed, post the unit (${label})`, async () => {
    const D1 = sqliteD1({ guard });
    const ids = [sheet(D1, "ocr_done"), sheet(D1, "ocr_done"), sheet(D1, "ocr_done")];
    D1.db.prepare(`UPDATE reports SET status = 'verified' WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    const u = await processUnit(D1, PU, RACE);
    assert.equal(u.consensus.status, "high");
    assert.equal(entries(D1), 1);
  });

  test(`machine readings do not add to a person-confirmed count (${label})`, async () => {
    const D1 = sqliteD1({ guard });
    sheet(D1, "verified"); sheet(D1, "verified");
    for (let i = 0; i < 3; i++) sheet(D1, "ocr_done");
    const u = await processUnit(D1, PU, RACE);
    assert.equal(u.consensus.reports, 2);
    assert.notEqual(u.consensus.status, "high", "two confirmed sheets are not enough; the machine readings do not make up the third");
    assert.equal(entries(D1), 0);
  });
}

test("the correction route's register check ignores a machine-read sheet's register", async () => {
  // A posted unit with no person-confirmed register, and an "ocr_done" sheet whose register (100) is below the corrected
  // votes. Before session 215 that sheet's register refused the correction (409); a machine reading no longer counts.
  const D1 = sqliteD1();
  const e = await appendEntry(D1, { kind: "tally", pu_code: PU, race: RACE, tally: T });
  D1.db.prepare("INSERT INTO unit_consensus (pu_code, race, status, share, reports, tally_json, ledger_hash) VALUES (?, ?, 'high', 1, 3, ?, ?)").run(PU, RACE, JSON.stringify(T), e.hash);
  sheet(D1, "ocr_done", { register: 100 });
  const realFetch = globalThis.fetch;
  const flag = { id: "11111111-2222-3333-4444-555555555555", pu_code: PU, race: RACE, status: "escalated", proposed_tally: { PA: 90, PB: 95 }, raised_by_public_id: "V0042", nrv_public_id: "V0130" };
  const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/auth/v1/user")) return ok({ id: "u-admin", email: "admin@example.org" });
    if (u.includes("/rest/v1/verifiers?")) return ok([{ role: "superadmin", public_id: "V0001" }]);
    if (u.includes("/rest/v1/discrepancy_flags?") && init.method === "PATCH") return ok([{ id: flag.id }]);
    if (u.includes("/rest/v1/discrepancy_flags?")) return ok([flag]);
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const token = `x.${Buffer.from(JSON.stringify({ aal: "aal2" })).toString("base64url")}.y`;
    const request = new Request("https://binchika.com/api/admin/decide", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ flagId: flag.id, decision: "approve", note: "AI re-check matches the photos." }),
    });
    const r = await decideRoute({ request, env: { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", DB: D1 } });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  } finally { globalThis.fetch = realFetch; }
});

test("no counting query in the code still names ocr_done", () => {
  for (const f of ["../functions/_lib/pipeline.js", "../functions/api/admin/decide.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /status IN \([^)]*'ocr_done'/, f);
  }
});
