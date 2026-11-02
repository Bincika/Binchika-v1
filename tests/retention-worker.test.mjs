import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { purgeVerifierData, purgePhotos, runRetention, PHOTO_PAGE } from "../workers/keepalive/src/retention.js";
import { mediaKeyOf } from "../functions/_lib/evidence.js";

const SETTINGS = { SUPABASE_URL: "https://s.test", SUPABASE_SERVICE_ROLE_KEY: "k", APPLICATION_RETENTION_DAYS: "90", SEAT_HOLDER_RETENTION_MONTHS: "12", GOVERNORSHIP_FINAL_RESULTS: "", PHOTO_DELETE_FROM: "2028-02-06", RETENTION_DRY_RUN: "false" };
const quiet = (fn) => async () => { const l = console.log; console.log = () => {}; try { await fn(); } finally { console.log = l; } };

test("verifier data: calls retention_purge with the configured periods and logs counts only", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => (calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }),
    new Response(JSON.stringify({ dry_run: false, applications_due: false, applications: 0, seat_holders: 2, unpledged_accounts: 0, pledges: 2, public_ids: ["V0100", "V0101"] }), { status: 200 }));
  const now = new Date("2027-03-01T06:17:00Z");
  const r = await purgeVerifierData(SETTINGS, now);
  assert.equal(calls[0].url, "https://s.test/rest/v1/rpc/retention_purge");
  assert.deepEqual(calls[0].body, { p_now: "2027-03-01T06:17:00.000Z", p_governorship_final: null, p_application_days: 90, p_holder_months: 12, p_dry_run: false });
  assert.equal(calls[0].auth, "Bearer k");
  assert.deepEqual(r, { dryRun: false, applicationsDue: false, applications: 0, seatHolders: 2, unpledgedAccounts: 0, pledges: 2 });
  assert.equal(JSON.stringify(r).includes("V0100"), false, "public IDs never reach the logs");
  await purgeVerifierData({ ...SETTINGS, GOVERNORSHIP_FINAL_RESULTS: "2027-03-15", RETENTION_DRY_RUN: "TRUE" }, now);
  assert.deepEqual([calls[1].body.p_governorship_final, calls[1].body.p_dry_run], ["2027-03-15", true]);
});

test("verifier data: invalid settings delete nothing; a database error is reported", async () => {
  let called = 0;
  globalThis.fetch = async () => (called++, new Response("{}", { status: 200 }));
  for (const bad of [{ APPLICATION_RETENTION_DAYS: "7" }, { APPLICATION_RETENTION_DAYS: "ninety" }, { SEAT_HOLDER_RETENTION_MONTHS: "0" }, { SEAT_HOLDER_RETENTION_MONTHS: "1.5" }, { GOVERNORSHIP_FINAL_RESULTS: "March 2027" }, { SUPABASE_URL: "" }]) {
    assert.ok((await purgeVerifierData({ ...SETTINGS, ...bad })).skipped, JSON.stringify(bad));
  }
  assert.equal(called, 0);
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  await assert.rejects(purgeVerifierData(SETTINGS), /retention_purge failed: 500/);
});

// Real SQLite with the real D1 migrations, and an R2 stand-in with paging.
function setup(keys) {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_ledger.sql", "0005_evidence.sql", "0006_media.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }) });
  const DB = { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); } };
  const store = new Set(keys), deleted = [];
  keys.filter((k) => k.startsWith("full/")).forEach((k, i) => db.prepare("INSERT INTO reports (id, channel, reporter_hash, media_ref, status) VALUES (?, 'web', 'h', ?, 'needs_review')").run(`r${i}`, `r2:${k}`));
  const EVIDENCE = {
    list: async ({ prefix, limit, cursor }) => {
      const all = [...store].filter((k) => k.startsWith(prefix)).sort(), start = Number(cursor ?? 0), page = all.slice(start, start + limit);
      return { objects: page.map((key) => ({ key })), truncated: start + limit < all.length, cursor: String(start + limit) };
    },
    delete: async (k) => { for (const x of [k].flat()) { store.delete(x); deleted.push(x); } },
  };
  return { db, DB, EVIDENCE, store, deleted };
}

test("photos: nothing before 6 Feb 2028; from then every file under full/ is deleted and its report marked", async () => {
  const keys = ["full/2027/24-09-05-012/a.jpg", "full/2027/24-09-05-012/b.mp4", "mail/raw/x.eml", "tmp/up.jpg"];
  const s = setup(keys);
  const env = { ...SETTINGS, DB: s.DB, EVIDENCE: s.EVIDENCE };
  assert.deepEqual(await purgePhotos(env, new Date("2028-02-05T23:59:00Z")), { skipped: "not before 2028-02-06" });
  assert.equal(s.deleted.length, 0);
  const r = await purgePhotos(env, new Date("2028-02-06T06:17:00Z"));
  assert.deepEqual(r, { dryRun: false, photos: 2, more: false });
  assert.deepEqual([...s.store].sort(), ["mail/raw/x.eml", "tmp/up.jpg"], "only full/ is touched");
  const refs = s.db.prepare("SELECT media_ref FROM reports ORDER BY id").all().map((x) => x.media_ref);
  assert.deepEqual(refs, ["deleted:2028-02-06", "deleted:2028-02-06"]);
  assert.equal(mediaKeyOf(refs[0]), null, "the evidence viewer treats it as gone");
});

test("photos: dry run, invalid date, missing bindings and large backlogs", async () => {
  const many = Array.from({ length: PHOTO_PAGE * 2 + 7 }, (_, i) => `full/2027/x/${String(i).padStart(5, "0")}.jpg`);
  const s = setup(many);
  const dry = await purgePhotos({ ...SETTINGS, DB: s.DB, EVIDENCE: s.EVIDENCE, RETENTION_DRY_RUN: "true" }, new Date("2028-03-01T00:00:00Z"));
  assert.deepEqual([dry.dryRun, dry.photos, s.deleted.length], [true, many.length, 0], "dry run counts every page and deletes nothing");
  const real = await purgePhotos({ ...SETTINGS, DB: s.DB, EVIDENCE: s.EVIDENCE }, new Date("2028-03-01T00:00:00Z"));
  assert.deepEqual([real.photos, s.store.size], [many.length, 0], "all pages deleted");
  for (const bad of ["", "06/02/2028", "2028-02-30x"]) assert.match((await purgePhotos({ ...SETTINGS, PHOTO_DELETE_FROM: bad })).skipped, /invalid PHOTO_DELETE_FROM/);
  assert.deepEqual(await purgePhotos({ ...SETTINGS }, new Date("2028-03-01T00:00:00Z")), { skipped: "not configured" });
});

test("runRetention: one part failing never stops the other, and it never throws", quiet(async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const s = setup(["full/a.jpg"]);
  const out = await runRetention({ ...SETTINGS, DB: s.DB, EVIDENCE: s.EVIDENCE }, new Date("2028-03-01T00:00:00Z"));
  assert.match(out["verifier-data"].error, /503/);
  assert.equal(out.photos.photos, 1);
}));
