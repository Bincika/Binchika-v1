// Session 143: the owner-only Diagnostics section (docs/egm/owner-diagnostics/build-plan.md).
// The route is BinchikAdmin + MFA only, reads nothing before that gate, and never returns a secret value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { collect } from "../functions/_lib/diagnostics.js";
import * as route from "../functions/api/admin/diagnostics.js";

const ROOT = new URL("../", import.meta.url);
const SECRET_NAMES = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "INVITE_PEPPER", "RESEND_API_KEY", "UNSUBSCRIBE_KEY", "INGEST_TOKEN", "REPORTER_HASH_SALT", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_S3_ENDPOINT"];
const PRINT = (n) => Array.from({ length: 32 }, (_, i) => ((i * 7 + n) % 256).toString(16).padStart(2, "0").toUpperCase()).join(":");
const links = (prints, pkg = "com.binchika.app") => JSON.stringify([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints } }]);
const reply = (body, status = 200, type = "application/json") => new Response(body, { status, headers: { "content-type": type } });
const dbOk = { prepare: () => ({ first: async () => ({ ok: 1 }) }) };
const supaEnv = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" };
const quiet = { fetchImpl: async () => reply("{}"), readAssetLinks: async () => reply(links([PRINT(1)])) };
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("the gate comes first: 401, 503 and both 403 cases read nothing", async () => {
  const cases = [
    { name: "no token", env: { ...supaEnv }, headers: {}, role: null, want: 401 },
    { name: "Supabase not configured", env: {}, headers: {}, role: null, want: 503 },
    { name: "OpsAdmin with MFA", env: { ...supaEnv }, headers: { authorization: `Bearer ${jwt({ aal: "aal2" })}` }, role: "admin", want: 403 },
    { name: "BinchikAdmin role without MFA", env: { ...supaEnv }, headers: { authorization: `Bearer ${jwt({ aal: "aal1" })}` }, role: "superadmin", want: 403 },
  ];
  for (const c of cases) {
    let dbCalls = 0, assetCalls = 0;
    const seen = [];
    const env = { ...c.env, DB: { prepare: () => { dbCalls++; return { first: async () => ({ ok: 1 }) }; } }, ASSETS: { fetch: async () => { assetCalls++; return reply(links([PRINT(1)])); } } };
    const r = await withFetch(async (url) => {
      seen.push(String(url));
      if (String(url).includes("/auth/v1/user")) return reply(JSON.stringify({ id: "u1", email: "someone@example.org" }));
      if (String(url).includes("/rest/v1/verifiers")) return reply(JSON.stringify([{ role: c.role, public_id: "V0002" }]));
      return reply("{}");
    }, () => route.onRequestGet({ request: new Request("https://binchika.test/api/admin/diagnostics", { headers: c.headers }), env }));
    assert.equal(r.status, c.want, c.name);
    assert.equal(dbCalls, 0, `${c.name}: database untouched`);
    assert.equal(assetCalls, 0, `${c.name}: app-link file untouched`);
    assert.ok(!seen.some((u) => u.includes("/auth/v1/settings")), `${c.name}: no Supabase probe`);
    assert.equal(r.headers.get("cache-control"), "no-store", c.name);
  }
});

test("no secret value, length, prefix or hash is ever returned", async () => {
  const env = { DB: dbOk, EVIDENCE: {}, AI: {}, APPLICATIONS_OPEN: "true", PRIVACY_NOTICE_VERSION: "PN-2026-1", OCR_ENGINE: "off", RESULTS_SOURCE: "snapshot" };
  for (const n of SECRET_NAMES) env[n] = `sentinel-${n.toLowerCase()}-value`;
  const text = JSON.stringify(await collect(env, quiet));
  for (const n of SECRET_NAMES) assert.ok(!text.includes(env[n]), `${n} value is not in the answer`);
  assert.ok(!/sentinel/.test(text));
  assert.ok(!/"(length|prefix|hash|value)"/i.test(text), "no field describes a value");
  const out = JSON.parse(text);
  for (const n of SECRET_NAMES) assert.equal(out.secrets[n], true, n);
});

test("an empty environment is reported truthfully and does not throw", async () => {
  const out = await collect({}, { fetchImpl: async () => { throw new Error("no network"); } });
  assert.deepEqual(out.bindings, { DB: false, EVIDENCE: false, AI: false });
  for (const n of SECRET_NAMES) assert.equal(out.secrets[n], false, n);
  assert.deepEqual(out.switches, { applicationsOpen: false, privacyNoticeVersion: null, ocrEngine: "off", resultsSource: "scan" });
  assert.deepEqual(out.database, { reachable: false });
  assert.deepEqual(out.supabase, { configured: false, reachable: false });
  assert.deepEqual(out.appLink, { readable: false, package: null, fingerprints: 0, playSigningKeyListed: false });
  assert.match(out.time, /^\d{4}-\d{2}-\d{2}T/);
});

test("applications-open follows the published four-part rule", async () => {
  const full = { ...supaEnv, APPLICATIONS_OPEN: "true", PRIVACY_NOTICE_VERSION: "PN-2026-1", INVITE_PEPPER: "p" };
  assert.equal((await collect(full, quiet)).switches.applicationsOpen, true);
  for (const k of ["APPLICATIONS_OPEN", "PRIVACY_NOTICE_VERSION", "INVITE_PEPPER", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const e = { ...full };
    delete e[k];
    assert.equal((await collect(e, quiet)).switches.applicationsOpen, false, `without ${k}`);
  }
  assert.equal((await collect({ ...full, APPLICATIONS_OPEN: "TRUE" }, quiet)).switches.applicationsOpen, false, "only the exact word true");
});

test("switches return allow-listed words only", async () => {
  const s = async (env) => (await collect(env, quiet)).switches;
  assert.equal((await s({ OCR_ENGINE: "<script>alert(1)</script>" })).ocrEngine, "other");
  assert.equal((await s({ OCR_ENGINE: "workers-ai" })).ocrEngine, "workers-ai");
  assert.equal((await s({ OCR_ENGINE: "off" })).ocrEngine, "off");
  assert.equal((await s({ RESULTS_SOURCE: "snapshot" })).resultsSource, "snapshot");
  assert.equal((await s({ RESULTS_SOURCE: "anything else" })).resultsSource, "scan");
  assert.equal((await s({ PRIVACY_NOTICE_VERSION: "PN-2026-1" })).privacyNoticeVersion, "PN-2026-1");
  assert.equal((await s({ PRIVACY_NOTICE_VERSION: "see the owner's notes" })).privacyNoticeVersion, "set");
});

test("database probe: SELECT 1 only; a throw or a missing binding is false", async () => {
  const asked = [];
  const out = await collect({ DB: { prepare: (q) => { asked.push(q); return { first: async () => ({ ok: 1 }) }; } } }, quiet);
  assert.equal(out.database.reachable, true);
  assert.deepEqual(asked, ["SELECT 1 AS ok"], "no table is read and nothing is counted");
  assert.equal((await collect({ DB: { prepare: () => { throw new Error("down"); } } }, quiet)).database.reachable, false);
  assert.equal((await collect({ DB: { prepare: () => ({ first: async () => null }) } }, quiet)).database.reachable, false);
  assert.equal((await collect({}, quiet)).database.reachable, false);
});

test("Supabase probe: 200 is reachable; a refusal or a thrown fetch is not; unconfigured makes no request", async () => {
  const calls = [];
  const ok = await collect({ ...supaEnv }, { ...quiet, fetchImpl: async (url, init) => { calls.push([String(url), init]); return reply("{}"); } });
  assert.deepEqual(ok.supabase, { configured: true, reachable: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://example.supabase.co/auth/v1/settings");
  assert.equal(calls[0][1].headers.apikey, "anon", "the publishable key, never the service key");
  assert.ok(!("cf" in calls[0][1]), "never a stored answer");
  assert.equal((await collect({ ...supaEnv }, { ...quiet, fetchImpl: async () => reply("{}", 401) })).supabase.reachable, false);
  assert.equal((await collect({ ...supaEnv }, { ...quiet, fetchImpl: async () => { throw new Error("x"); } })).supabase.reachable, false);
  let n = 0;
  const off = await collect({ SUPABASE_URL: "https://example.supabase.co" }, { ...quiet, fetchImpl: async () => { n++; return reply("{}"); } });
  assert.deepEqual(off.supabase, { configured: false, reachable: false });
  assert.equal(n, 0);
});

test("app link: counts fingerprints, never returns them, and refuses anything that is not the real shape", async () => {
  const al = async (readAssetLinks) => (await collect({}, { ...quiet, readAssetLinks })).appLink;
  assert.deepEqual(await al(async () => reply(links([PRINT(1)]))), { readable: true, package: "com.binchika.app", fingerprints: 1, playSigningKeyListed: false });
  const two = await collect({}, { ...quiet, readAssetLinks: async () => reply(links([PRINT(1), PRINT(2)])) });
  assert.deepEqual(two.appLink, { readable: true, package: "com.binchika.app", fingerprints: 2, playSigningKeyListed: true });
  assert.ok(!JSON.stringify(two).includes(PRINT(1)) && !JSON.stringify(two).includes(PRINT(2)));
  const bad = { readable: false, package: null, fingerprints: 0, playSigningKeyListed: false };
  assert.deepEqual(await al(async () => reply("not found", 404)), bad, "404");
  assert.deepEqual(await al(async () => reply("<!doctype html><title>Binchika</title>", 200, "text/html")), bad, "an HTML page with status 200");
  assert.deepEqual(await al(async () => reply("{not json")), bad, "invalid JSON");
  assert.deepEqual(await al(async () => reply(JSON.stringify({ target: {} }))), bad, "not an array");
  assert.deepEqual(await al(async () => reply(JSON.stringify([{ target: { namespace: "web", sha256_cert_fingerprints: [PRINT(1)] } }]))), bad, "wrong namespace");
  assert.deepEqual(await al(async () => { throw new Error("x"); }), bad, "a thrown read");
  assert.deepEqual(await al(undefined), bad, "no reader");
  assert.equal((await al(async () => reply(links([PRINT(1), "junk", 5])))).fingerprints, 1, "only real fingerprints count");
  assert.equal((await al(async () => reply(links([PRINT(1)], "<b>x</b>")))).package, null, "the package name is not echoed unless it is one");
});

test("a probe that never answers is reported as false after the time limit", async () => {
  const never = () => new Promise(() => {});
  const out = await collect({ ...supaEnv, DB: { prepare: () => ({ first: never }) } }, { fetchImpl: never, readAssetLinks: never, timeoutMs: 20 });
  assert.equal(out.database.reachable, false);
  assert.equal(out.supabase.reachable, false);
  assert.equal(out.appLink.readable, false);
});

test("POST is 405 with Allow: GET and reads nothing", async () => {
  const r = route.onRequestPost();
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { error: "method not allowed", allow: "GET" });
});

test("portal: Diagnostics is a BinchikAdmin-only section, loaded only when opened, and shows no user agent", () => {
  const js = readFileSync(new URL("site/assets/js/portal.js", ROOT), "utf8");
  const roles = js.slice(js.indexOf("const ROLE_SECTIONS = {"), js.indexOf("};", js.indexOf("const ROLE_SECTIONS = {")));
  const line = (role) => roles.split("\n").find((l) => l.trim().startsWith(`${role}:`)) ?? "";
  assert.ok(line("superadmin").includes('"diagnostics"'));
  for (const role of ["szv", "nrv", "admin"]) assert.ok(!line(role).includes("diagnostics"), `${role} has no Diagnostics section`);
  assert.ok(/const VIEWS = \{[^}]*diagnostics: diagnosticsView/.test(js));
  assert.ok(/diagnostics: \["Diagnostics", "/.test(js), "menu label and icon");
  const start = js.indexOf("async function loadReal()");
  const loadReal = js.slice(start, js.indexOf("async function", start + 10));
  assert.ok(start > 0 && !loadReal.includes("/api/admin/diagnostics"), "sign-in does not wait for diagnostics");
  assert.equal((js.match(/fetch\("\/api\/admin\/diagnostics"/g) ?? []).length, 1, "one place calls the route");
  assert.ok(!js.includes("navigator.userAgent"), "the user agent is neither shown nor sent");
  assert.ok(js.includes('section !== "diagnostics"'), "the wiring does nothing on other sections");
});

test("the repository's own app-link file is read correctly", { skip: !existsSync(new URL("site/.well-known/assetlinks.json", ROOT)) }, async () => {
  const body = readFileSync(new URL("site/.well-known/assetlinks.json", ROOT), "utf8");
  const n = JSON.parse(body)[0].target.sha256_cert_fingerprints.length;
  const out = await collect({}, { ...quiet, readAssetLinks: async () => reply(body) });
  assert.deepEqual(out.appLink, { readable: true, package: "com.binchika.app", fingerprints: n, playSigningKeyListed: n >= 2 });
});
