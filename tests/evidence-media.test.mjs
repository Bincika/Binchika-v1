import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mediaKeyOf, MAX_MEDIA_BYTES } from "../functions/_lib/evidence.js";
import { onRequestGet as getMedia } from "../functions/api/portal/evidence-media.js";

// Real SQLite with the real D1 migrations, so the SQL itself is tested.
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_ledger.sql", "0005_evidence.sql", "0006_media.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }) });
  return { db, prepare: (sql) => stmt(sql) };
}
const SHA = "a".repeat(64);
function setup() {
  const D1 = sqliteD1();
  const add = (id, pu, mediaRef, evidence = "board") => D1.db.prepare("INSERT INTO reports (id, channel, reporter_hash, pu_code, race, media_ref, media_sha256, tally_json, status, evidence, audit_status) VALUES (?, 'web', 'h', ?, 'president', ?, ?, '{\"A\":1}', 'needs_review', ?, 'pending')").run(id, pu, mediaRef, SHA, evidence);
  add("lagos", "24-09-05-012", "r2:full/2027/24-09-05-012/lagos.jpg");
  add("kano", "20-01-01-001", "r2:full/2027/20-01-01-001/kano.jpg");
  add("nomedia", "24-09-05-012", "tg-file:ABC");
  add("mailraw", "24-09-05-012", "r2:mail/raw/x.eml");
  add("sneaky", "24-09-05-012", "r2:full/../mail/raw/x.eml");
  add("gone", "24-09-05-012", "r2:full/missing.jpg");
  add("exe", "24-09-05-012", "r2:full/a.bin");
  add("huge", "24-09-05-012", "r2:full/huge.mp4", "video");
  const files = {
    "full/2027/24-09-05-012/lagos.jpg": { type: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 1, 2, 3]) },
    "full/2027/20-01-01-001/kano.jpg": { type: "image/jpeg", bytes: new Uint8Array([255, 216, 255]) },
    "full/a.bin": { type: "application/octet-stream", bytes: new Uint8Array([1]) },
    "full/huge.mp4": { type: "video/mp4", bytes: new Uint8Array([0]), size: MAX_MEDIA_BYTES + 1 },
  };
  const gets = [];
  const EVIDENCE = { get: async (k) => (gets.push(k), files[k] ? { body: files[k].bytes, size: files[k].size ?? files[k].bytes.length, httpMetadata: { contentType: files[k].type } } : null) };
  return { D1, EVIDENCE, gets };
}
// Supabase stand-in: the token names the user; verifiers by user id.
const VERIFIERS = { szv: { role: "szv", public_id: "V0007", state_iso: "NG-LA", region_id: null }, nrv: { role: "nrv", public_id: "V0042", state_iso: null, region_id: "R6" }, ops: { role: "admin", public_id: "V0002", state_iso: null, region_id: null } };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "szv" }), { status: 200 });
  if (u.includes("/rest/v1/verifiers")) { const id = decodeURIComponent(u.match(/user_id=eq\.([^&]+)/)[1]); return new Response(JSON.stringify(VERIFIERS[id] ? [VERIFIERS[id]] : []), { status: 200 }); }
  if (u.includes("/rest/v1/region_states")) return new Response(JSON.stringify([{ state_iso: "NG-LA" }, { state_iso: "NG-OG" }, { state_iso: "NG-OY" }]), { status: 200 });
  return new Response("{}", { status: 404 });
};
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const SUPA = { SUPABASE_URL: "https://s.test", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s" };
async function call(env, id, { user = "szv", aal = "aal2", token = true } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).endsWith("/auth/v1/user") ? new Response(JSON.stringify({ id: user }), { status: 200 }) : realFetch(url, init));
  try {
    const headers = token ? { authorization: `Bearer ${jwt({ aal, sub: user })}` } : {};
    return await getMedia({ request: new Request(`https://x/api/portal/evidence-media?id=${encodeURIComponent(id)}`, { headers }), env });
  } finally { globalThis.fetch = realFetch; }
}
const quiet = (fn) => async () => { const l = console.log; console.log = () => {}; try { await fn(); } finally { console.log = l; } };

test("viewer: only r2:full/ keys are evidence; no traversal, no other prefixes", () => {
  assert.equal(mediaKeyOf("r2:full/2027/24-09-05-012/a.jpg"), "full/2027/24-09-05-012/a.jpg");
  for (const bad of ["r2:mail/raw/x.eml", "r2:tmp/x.jpg", "r2:full/../mail/raw/x", "r2:full//x.jpg", "r2:full/./x.jpg", "tg-file:ABC", "full/x.jpg", "", null, "r2:full/x y.jpg"]) assert.equal(mediaKeyOf(bad), null, String(bad));
});

test("viewer: a Lagos SZV with MFA sees Lagos evidence, privately and unframeable, with the intake fingerprint", quiet(async () => {
  const { D1, EVIDENCE } = setup();
  const r = await call({ ...SUPA, DB: D1, EVIDENCE }, "lagos");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(r.headers.get("x-evidence-sha256"), SHA);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [255, 216, 255, 1, 2, 3]);
  assert.equal((await call({ ...SUPA, DB: D1, EVIDENCE }, "lagos", { user: "nrv" })).status, 200, "the South-West NRV can view it too");
}));

test("viewer: refuses without sign-in, without MFA, for admins, outside the area, and for anything that is not stored evidence", quiet(async () => {
  const { D1, EVIDENCE, gets } = setup();
  const env = { ...SUPA, DB: D1, EVIDENCE };
  const status = async (id, o) => (await call(env, id, o)).status;
  assert.equal(await status("lagos", { token: false }), 401);
  assert.equal(await status("lagos", { user: "stranger" }), 403, "not a verifier");
  assert.equal(await status("lagos", { user: "ops" }), 403, "OpsAdmin is not an auditor");
  const mfa = await call(env, "lagos", { aal: "aal1" });
  assert.deepEqual([mfa.status, (await mfa.json()).mfa], [403, true], "MFA required");
  assert.equal(await status("kano"), 403, "Lagos SZV cannot see Kano evidence");
  assert.equal(await status("kano", { user: "nrv" }), 403, "South-West NRV cannot see Kano evidence");
  assert.equal(await status("nope"), 404);
  assert.equal(await status("nomedia"), 409, "Telegram file ids are not served");
  assert.equal(await status("mailraw"), 409, "the mailbox prefix is never served");
  assert.equal(await status("sneaky"), 409, "no path traversal");
  assert.equal(await status("gone"), 404);
  assert.equal(await status("exe"), 415);
  assert.equal(await status("huge"), 413);
  assert.equal(gets.some((k) => !k.startsWith("full/")), false, "R2 is only ever read under full/");
  assert.equal((await call({ DB: D1, EVIDENCE }, "lagos")).status, 503, "unconfigured");
}));
