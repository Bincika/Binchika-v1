import { test } from "node:test";
import assert from "node:assert/strict";
import * as ocr from "../functions/api/pipeline/ocr.js";
import * as official from "../functions/api/pipeline/official.js";
import * as review from "../functions/api/portal/review.js";
import * as decide from "../functions/api/admin/decide.js";

// Session 90: GET on a write route answers 405 with "Allow: POST" instead of falling through to the home page (the soft
// 404). The handler reads nothing: no request, no environment, no database.
test("write routes answer GET with 405 and Allow: POST, and keep their POST handler", async () => {
  for (const [name, mod] of Object.entries({ ocr, official, review, decide })) {
    assert.equal(typeof mod.onRequestPost, "function", `${name} still has POST`);
    const r = mod.onRequestGet();
    assert.equal(r.status, 405, name);
    assert.equal(r.headers.get("allow"), "POST", name);
    assert.equal(r.headers.get("cache-control"), "no-store", name);
    assert.deepEqual(await r.json(), { error: "method not allowed", allow: "POST" }, name);
  }
});

// Session 211 (build plan 8): the admin-only "Corrections to check" list. POST answers 405 with "Allow: GET" and reads
// nothing; GET without a session is refused before anything is read (no Supabase settings: 503; no sign-in: 401).
test("correction-conflicts: POST 405 with Allow: GET; GET refused without the admin session", async () => {
  const mod = await import("../functions/api/admin/correction-conflicts.js");
  const r = mod.onRequestPost();
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const touched = [];
  const DB = { prepare: (sql) => { touched.push(sql); throw new Error("read before the gate"); }, batch: () => { throw new Error("read before the gate"); } };
  const unconfigured = await mod.onRequestGet({ request: new Request("https://binchika.com/api/admin/correction-conflicts"), env: { DB } });
  assert.equal(unconfigured.status, 503);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  try {
    const anon = await mod.onRequestGet({ request: new Request("https://binchika.com/api/admin/correction-conflicts"), env: { DB, SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s" } });
    assert.equal(anon.status, 401);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(touched, [], "the database is not read before the gate passes");
});
