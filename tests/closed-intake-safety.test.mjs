// Session 233: closed-intake safety fixes (owner brief, items 1, 2, 3, 4, 8 and 9 of the 17 November 2026 build
// analysis). Written before the code; each test names the fix it proves. Nothing here opens an intake path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

// A bearer token whose claims say which authenticator level the session reached (the server only reads `aal` after
// Supabase has validated the token, which the fetch stub below stands in for).
const token = (aal) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;
const SUPA = { SUPABASE_URL: "https://supa.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" };
const SZV = { role: "szv", public_id: "V0007", state_iso: "XL-LA", region_id: null };
async function withFetchStub(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const supaStub = async (url) => {
  const u = String(url);
  if (u.endsWith("/auth/v1/user")) return Response.json({ id: "user-1" });
  if (u.includes("/rest/v1/verifiers")) return Response.json([SZV]);
  return Response.json([]);
};
const untouchedDb = () => ({ calls: 0, prepare() { this.calls++; throw new Error("the database must not be touched"); } });

// ---------- Fix 1: the report list and evidence decisions need aal2 ----------
import { onRequestGet as portalReports } from "../functions/api/portal/reports.js";
import { onRequestPost as portalEvidence } from "../functions/api/portal/evidence.js";
import { auditEvidence } from "../functions/_lib/evidence.js";

test("Fix 1: the report list refuses a session without the authenticator (aal1) before reading the database", async () => {
  const DB = untouchedDb();
  const res = await withFetchStub(supaStub, () => portalReports({ request: new Request("https://x.test/api/portal/reports", { headers: { authorization: `Bearer ${token("aal1")}` } }), env: { ...SUPA, DB } }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).mfa, true);
  assert.equal(DB.calls, 0);
});

test("Fix 1: the report list answers an aal2 session", async () => {
  let calls = 0;
  const DB = { prepare: () => { calls++; return { bind: () => ({ all: async () => ({ results: [] }) }) }; } };
  const res = await withFetchStub(supaStub, () => portalReports({ request: new Request("https://x.test/api/portal/reports", { headers: { authorization: `Bearer ${token("aal2")}` } }), env: { ...SUPA, DB } }));
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
});

test("Fix 1: an evidence decision refuses an aal1 session before reading the database", async () => {
  const DB = untouchedDb();
  const req = new Request("https://x.test/api/portal/evidence", { method: "POST", headers: { authorization: `Bearer ${token("aal1")}`, "content-type": "application/json" }, body: JSON.stringify({ reportId: "r1", decision: "approved", note: "a reason long enough" }) });
  const res = await withFetchStub(supaStub, () => portalEvidence({ request: req, env: { ...SUPA, DB } }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).mfa, true);
  assert.equal(DB.calls, 0);
});

test("Fix 1: auditEvidence itself refuses a verifier without aal2", async () => {
  const DB = untouchedDb();
  const r = await auditEvidence(DB, { reportId: "r1", decision: "approved", note: "a reason long enough" }, { role: "szv", public_id: "V0007", states: ["XL-LA"] });
  assert.equal(r.status, 403);
  assert.equal(r.body.mfa, true);
  assert.equal(DB.calls, 0);
});

test("Fix 1: the portal shows the authenticator step when the report list asks for it", () => {
  const js = read("site/assets/js/portal.js");
  assert.match(js, /mfa === true[\s\S]{0,200}mfaNeeded = true/, "a 403 with mfa: true from /api/portal/reports switches the portal to the authenticator step");
});

// ---------- Fix 2: every POST-only route answers GET with 405 JSON and Allow ----------
function walkJs(dir) {
  const out = [];
  for (const name of readdirSync(new URL(`${dir}/`, ROOT))) {
    const rel = `${dir}/${name}`;
    if (statSync(new URL(rel, ROOT)).isDirectory()) out.push(...walkJs(rel)); else if (name.endsWith(".js")) out.push(rel);
  }
  return out;
}
test("Fix 2: no write route lacks a GET answer (it would fall through to the site's 404 page)", () => {
  const missing = walkJs("functions/api").filter((f) => {
    const s = read(f);
    const writes = /export\s+(?:async\s+)?(?:function|const)\s+onRequest(Post|Put|Patch|Delete)\b/.test(s);
    const get = /export\s+(?:async\s+)?(?:function|const)\s+onRequest(Get)?\b/.test(s);
    return writes && !get;
  });
  assert.deepEqual(missing, []);
});

for (const [rel, path] of [["functions/api/pipeline/media.js", "pipeline/media"], ["functions/api/pipeline/unit.js", "pipeline/unit"], ["functions/api/telegram.js", "telegram"],
  ["functions/api/contact.js", "contact"], ["functions/api/r2-check.js", "r2-check"], ["functions/api/portal/evidence.js", "portal/evidence"]]) {
  test(`Fix 2: GET /api/${path} is 405 JSON with Allow: POST`, async () => {
    const mod = await import(new URL(rel, ROOT));
    const res = await mod.onRequestGet({ request: new Request(`https://x.test/api/${path}`), env: {} });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
    assert.match(res.headers.get("content-type"), /application\/json/);
  });
}

// ---------- Fix 3: the pipeline routes use the shared secret check and the one refusal ----------
import { unauthorised } from "../functions/_lib/http.js";
for (const name of ["ocr", "media", "unit"]) {
  test(`Fix 3: /api/pipeline/${name} uses sameSecret and unauthorised, with no private comparison`, async () => {
    const src = read(`functions/api/pipeline/${name}.js`);
    assert.match(src, /import\s*\{[^}]*\bsameSecret\b[^}]*\bunauthorised\b[^}]*\}\s*from\s*"\.\.\/\.\.\/_lib\/http\.js"/);
    assert.doesNotMatch(src, /async function authorised\(/);
    const mod = await import(new URL(`functions/api/pipeline/${name}.js`, ROOT));
    const expected = unauthorised();
    for (const env of [{}, { INGEST_TOKEN: "right" }]) {
      const res = await mod.onRequestPost({ request: new Request(`https://x.test/api/pipeline/${name}`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" }), env });
      assert.equal(res.status, 401);
      assert.equal(await res.text(), await expected.clone().text());
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });
}

// ---------- Fix 4: concurrent misses share one build ----------
import { readThroughCache } from "../functions/_lib/edge-cache.js";
test("Fix 4: two concurrent misses for one key run build() once and both get the body", async () => {
  const realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  try {
    let builds = 0;
    const build = async () => { builds++; await new Promise((r) => setTimeout(r, 20)); return { response: new Response("same", { headers: { "cache-control": "public, max-age=15" } }), store: true }; };
    const key = new Request("https://x.test/api/single-flight");
    const [a, b] = await Promise.all([readThroughCache({ key, build }), readThroughCache({ key, build })]);
    assert.equal(builds, 1);
    assert.equal(await a.text(), "same");
    assert.equal(await b.text(), "same");
    // After it settles, the next miss builds again (a failure is never shared with later requests).
    await readThroughCache({ key, build });
    assert.equal(builds, 2);
  } finally { globalThis.caches = realCaches; }
});

test("Fix 4: a failing build is shared by the callers waiting on it, then forgotten", async () => {
  const realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  try {
    let builds = 0;
    const build = async () => { builds++; await new Promise((r) => setTimeout(r, 10)); throw new Error("source down"); };
    const key = new Request("https://x.test/api/single-flight-fail");
    const results = await Promise.allSettled([readThroughCache({ key, build }), readThroughCache({ key, build })]);
    assert.equal(builds, 1);
    assert.ok(results.every((r) => r.status === "rejected"));
    await readThroughCache({ key, build }).catch(() => {});
    assert.equal(builds, 2);
  } finally { globalThis.caches = realCaches; }
});

// ---------- Fix 8: /api/config is cached for five minutes and gives no reason string ----------
import { onRequestGet as config } from "../functions/api/config.js";
test("Fix 8: config has no reason field, whatever is configured", async () => {
  for (const env of [{}, { SUPABASE_URL: "https://supa.test", SUPABASE_ANON_KEY: "k" }]) {
    const res = await withFetchStub(async () => new Response("{}", { status: 401 }), () => config({ request: new Request("https://x.test/api/config"), env }));
    assert.ok(!("reason" in (await res.json())));
  }
});

test("Fix 8: a working config is cached for five minutes; a failing one is never stored", async () => {
  const realCaches = globalThis.caches;
  const stored = [];
  globalThis.caches = { default: { match: async () => null, put: async (k, r) => { stored.push(r.headers.get("cache-control")); } } };
  try {
    const ok = await withFetchStub(async () => new Response("{}", { status: 200 }), () => config({ request: new Request("https://x.test/api/config"), env: { SUPABASE_URL: "https://supa.test", SUPABASE_ANON_KEY: "k" } }));
    assert.equal((await ok.json()).signIn, true);
    assert.match(ok.headers.get("cache-control"), /max-age=300/);
    assert.equal(stored.length, 1);
    const bad = await withFetchStub(async () => new Response("{}", { status: 401 }), () => config({ request: new Request("https://x.test/api/config"), env: { SUPABASE_URL: "https://supa.test", SUPABASE_ANON_KEY: "k" } }));
    assert.equal((await bad.json()).signIn, false);
    assert.equal(bad.headers.get("cache-control"), "no-store");
    assert.equal(stored.length, 1, "a failing config is not stored");
  } finally { globalThis.caches = realCaches; }
});

// ---------- Fix 9: the contact rate-limit row is written only after the provider accepts, with its own pepper ----------
import * as contactRoute from "../functions/api/contact.js";
const contactRequest = () => {
  const fd = new FormData();
  fd.set("nature", "other"); fd.set("name", "Ada"); fd.set("email", "ada@example.org");
  fd.set("message", "A test message that is comfortably longer than twenty characters."); fd.set("website", "");
  fd.set("renderedAt", String(Date.now() - 10_000));
  return new Request("https://example.test/api/contact", { method: "POST", body: fd, headers: { "cf-connecting-ip": "203.0.113.9" } });
};
const recordingDb = () => {
  const log = [];
  const stmt = (sql) => ({ bind: (...args) => { log.push({ sql, args }); return stmt(sql); }, first: async () => ({ n: 0 }), run: async () => ({ meta: { changes: 1 } }), all: async () => ({ results: [] }) });
  return { log, prepare: (sql) => stmt(sql) };
};
const inserts = (db) => db.log.filter((x) => /INSERT INTO contact_log/.test(x.sql));

test("Fix 9: no rate-limit row when the provider refuses the message", async () => {
  const DB = recordingDb();
  const res = await withFetchStub(async () => new Response("{}", { status: 500 }), () => contactRoute.onRequestPost({ request: contactRequest(), env: { RESEND_API_KEY: "k", EMAIL_FORWARD_TO: "owner@example.org", DB } }));
  assert.equal(res.status, 502);
  assert.equal(inserts(DB).length, 0);
});

test("Fix 9: one rate-limit row after the provider accepts, hashed with CONTACT_HASH_PEPPER when set", async () => {
  const run = async (env) => {
    const DB = recordingDb();
    const res = await withFetchStub(async () => new Response("{}", { status: 200 }), () => contactRoute.onRequestPost({ request: contactRequest(), env: { RESEND_API_KEY: "k", EMAIL_FORWARD_TO: "owner@example.org", DB, ...env } }));
    assert.equal(res.status, 200);
    assert.equal(inserts(DB).length, 1);
    return inserts(DB)[0].args[0];
  };
  const withSalt = await run({ REPORTER_HASH_SALT: "salt" });
  const withPepper = await run({ REPORTER_HASH_SALT: "salt", CONTACT_HASH_PEPPER: "pepper" });
  assert.match(withSalt, /^[0-9a-f]{64}$/);
  assert.match(withPepper, /^[0-9a-f]{64}$/);
  assert.notEqual(withSalt, withPepper, "the contact pepper, when set, replaces the reporter salt");
});
