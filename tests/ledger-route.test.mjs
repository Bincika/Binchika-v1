// Build plan 5 (session 184): GET /api/ledger reads through the edge cache with bounded keys, and counts from the head.
// docs/egm/audit-fixes/build-plan-5.md, section 7 and the Gate 1 resolutions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ledgerRoute from "../functions/api/ledger.js";
import { makeEntry, genesis, verifyChain } from "../functions/_lib/ledger.js";
import { CYCLE } from "../functions/_lib/pipeline.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A stub D1 holding a real hash chain of n entries. Records every SQL statement; can be told to fail. */
async function ledgerDb(n, { fail = null } = {}) {
  const rows = [];
  let prev = await genesis(CYCLE);
  for (let seq = 1; seq <= n; seq++) {
    const e = await makeEntry({ seq, kind: "tally", pu_code: `01-01-01-00${seq}`, race: "president", tally: { AAA: seq } }, prev, "2027-01-16T18:00:00.000Z");
    rows.push({ seq, body_json: JSON.stringify(e), hash: e.hash });
    prev = e.hash;
  }
  const db = { sql: [], reads: 0, rows };
  const run = (sql, args) => {
    db.sql.push(sql); db.reads++;
    if (fail && fail.test(sql)) throw new Error("database down");
    if (/COUNT\(/i.test(sql)) return { results: [{ n: rows.length }] };
    if (/ORDER BY seq DESC LIMIT 1/i.test(sql)) return { results: rows.length ? [{ seq: rows.at(-1).seq, hash: rows.at(-1).hash }] : [] };
    if (/WHERE seq > \?1 ORDER BY seq LIMIT \?2/i.test(sql)) return { results: rows.filter((r) => r.seq > args[0]).slice(0, args[1]) };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => run(sql, args),
    first: async () => run(sql, args).results[0] ?? null,
  });
  db.prepare = (sql) => stmt(sql);
  db.batch = async (stmts) => stmts.map((s) => run(s.sql, s.args));
  return db;
}

const cacheStub = () => {
  const store = new Map();
  return { store, puts: [],
    async match(key) { const hit = store.get(key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { this.puts.push(key.url); store.set(key.url, response.clone()); },
  };
};
async function withCache(cache, run) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { value: { default: cache }, configurable: true, writable: true });
  try { return await run(); } finally { if (had) Object.defineProperty(globalThis, "caches", had); else delete globalThis.caches; }
}
const get = (query, env) => ledgerRoute.onRequestGet({ request: new Request(`https://example.test/api/ledger${query}`), env });
const entriesKey = (k) => k.startsWith("https://example.test/api/ledger?after=");

test("ledger: count comes from the head, with no whole-table count", async () => {
  const DB = await ledgerDb(7);
  const body = await (await withCache(cacheStub(), () => get("?after=0&limit=1000", { DB }))).json();
  assert.equal(body.count, 7);
  assert.equal(body.head, DB.rows.at(-1).hash);
  assert.equal(body.entries.length, 7);
  assert.ok(!DB.sql.some((s) => /COUNT\(/i.test(s)), "no COUNT(*) query");
});

test("ledger: the gap proof holds in the code (one insert, explicit seq, no AUTOINCREMENT, both triggers)", () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(join(root, d))) { const p = join(d, n); statSync(join(root, p)).isDirectory() ? walk(p) : files.push(p.replaceAll("\\", "/")); } };
  for (const d of ["functions", "workers", "scripts", "db"]) walk(d);
  const inserting = files.filter((f) => /\.(m?js|sql)$/.test(f) && /INSERT INTO ledger_entries/i.test(readFileSync(join(root, f), "utf8")));
  // The readiness script is private (left out of the open-source export), so it is expected only where it exists.
  const readiness = "scripts/readiness-2026-11-01.mjs";
  const hasReadiness = files.includes(readiness);
  assert.deepEqual(inserting.sort(), hasReadiness ? ["functions/_lib/pipeline.js", readiness] : ["functions/_lib/pipeline.js"]);
  if (hasReadiness) assert.ok(/\.startsWith\("INSERT INTO ledger_entries"\)/.test(readFileSync(join(root, readiness), "utf8")), "the readiness script only inspects SQL text");
  assert.ok(/seq: head\.seq \+ 1/.test(readFileSync(join(root, "functions/_lib/pipeline.js"), "utf8")), "appendEntry binds head.seq + 1");
  const schema = readFileSync(join(root, "db/d1/0002_ledger.sql"), "utf8");
  assert.ok(/seq\s+INTEGER PRIMARY KEY/.test(schema) && !/AUTOINCREMENT/i.test(schema));
  assert.ok(/ledger_no_update BEFORE UPDATE/.test(schema) && /ledger_no_delete BEFORE DELETE/.test(schema));
});

test("ledger: a second identical request is served from the cache without a database read", async () => {
  const DB = await ledgerDb(3), cache = cacheStub();
  await withCache(cache, async () => {
    const a = await get("?after=0&limit=1000", { DB });
    const readsAfterFirst = DB.reads;
    const b = await get("?after=0&limit=1000", { DB });
    assert.equal(a.headers.get("x-binchika-cache"), "miss");
    assert.equal(b.headers.get("x-binchika-cache"), "hit");
    assert.equal(DB.reads, readsAfterFirst, "no read for the hit");
    assert.deepEqual(await a.json(), await b.json());
  });
});

test("ledger: limit is normalised to 100, 500 or 1000", async () => {
  const cases = [["limit=999", 1000], ["limit=1000&x=1", 1000], ["limit=7", 100], ["", 500], ["limit=0", 500], ["limit=-5", 500], ["limit=abc", 500], ["limit=12abc", 500], ["limit=5000", 1000], ["limit=101", 500]];
  for (const [q, want] of cases) {
    const DB = await ledgerDb(2), cache = cacheStub();
    await withCache(cache, () => get(`?after=0&${q}`, { DB }));
    assert.deepEqual(cache.puts.filter(entriesKey), [`https://example.test/api/ledger?after=0&limit=${want}`], `${q} → ${want}`);
  }
});

test("ledger: every after beyond the head shares one key; walking past the head reads entries once", async () => {
  const DB = await ledgerDb(3), cache = cacheStub();
  await withCache(cache, async () => {
    for (const a of [4, 99, 999999]) await get(`?after=${a}&limit=1000`, { DB });
    for (let a = 4; a < 54; a++) await get(`?after=${a}&limit=1000`, { DB });
  });
  assert.deepEqual([...new Set(cache.puts.filter(entriesKey))], ["https://example.test/api/ledger?after=3&limit=1000"]);
  assert.equal(DB.sql.filter((s) => /WHERE seq > \?1/.test(s)).length, 1, "one entries read for 53 walked values");
});

test("ledger: negative, non-numeric or wrapping after becomes 0", async () => {
  for (const q of ["after=-4", "after=abc", "after=2147483648", ""]) {
    const DB = await ledgerDb(2), cache = cacheStub();
    await withCache(cache, () => get(`?${q}&limit=1000`, { DB }));
    assert.deepEqual(cache.puts.filter(entriesKey), ["https://example.test/api/ledger?after=0&limit=1000"], q);
  }
});

test("ledger: fail-closed — no database is answered but not stored; a failing entries read is a 503, not stored", async () => {
  const cache = cacheStub();
  await withCache(cache, async () => {
    const r = await get("?after=0&limit=1000", {});
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.count, 0);
    assert.deepEqual(body.entries, []);
    assert.equal(body.head, body.genesis);
  });
  assert.deepEqual(cache.puts, []);
  const DB = await ledgerDb(2, { fail: /WHERE seq > \?1/ }), cache2 = cacheStub();
  const r = await withCache(cache2, () => get("?after=0&limit=1000", { DB }));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { error: "ledger temporarily unavailable" });
  assert.deepEqual(cache2.puts.filter(entriesKey), []);
});

test("ledger: body keys and headers are unchanged", async () => {
  const DB = await ledgerDb(2);
  const r = await withCache(cacheStub(), () => get("?after=0&limit=1000", { DB }));
  const body = await r.json();
  assert.deepEqual(Object.keys(body).sort(), ["count", "cycle", "entries", "genesis", "head", "notice"]);
  assert.equal(r.headers.get("cache-control"), "public, max-age=10");
  assert.ok((await verifyChain(body.entries, body.genesis)).ok, "the served entries still form the hash chain");
});

test("ledger: a failing head read is a 503, stored nowhere, with no entries read", async () => {
  const DB = await ledgerDb(2, { fail: /ORDER BY seq DESC LIMIT 1/ }), cache = cacheStub();
  const r = await withCache(cache, () => get("?after=0&limit=1000", { DB }));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(cache.puts, []);
  assert.ok(!DB.sql.some((s) => /WHERE seq > \?1/.test(s)), "no entries read without a head");
});
