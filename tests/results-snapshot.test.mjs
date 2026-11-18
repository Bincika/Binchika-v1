// Session 111: precomputed totals. Real migrations and real SQL on node:sqlite, through a small adapter with D1's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { onRequestGet } from "../functions/api/results.js";
import { PRESS_NOTICE, onRequestGet as pressGet } from "../functions/api/press/snapshot.js";
import { recordCorrection } from "../functions/_lib/pipeline.js";
import { RESULTS_BODY_VERSION, RESULTS_RACES, SNAPSHOT_MAX_AGE_MS, resultsAccumulator, servedBody, statusCounts } from "../functions/_lib/results-body.js";
import { REBUILD_EVERY_MS, buildRace, runAll } from "../workers/results-snapshot/src/build.js";
import { createResultsFeed } from "../site/assets/js/lib/results-feed.js";
import { CORRECTION_GUARD_SCHEMA } from "./fixtures/correction-guard-schema.mjs";

function freshDb() {
  const raw = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../db/d1/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL(`../db/d1/${file}`, import.meta.url), "utf8"));
  const log = [];
  const db = {
    raw, log, beforeAll: null,
    prepare(sql) {
      const statement = (params) => ({
        bind: (...values) => statement(values),
        all: async () => { log.push(sql); if (db.beforeAll) await db.beforeAll(sql, params); return { results: raw.prepare(sql).all(...params).map((r) => ({ ...r })) }; },
        first: async () => { log.push(sql); const row = raw.prepare(sql).get(...params); return row ? { ...row } : null; },
        run: async () => { log.push(sql); const r = raw.prepare(sql).run(...params); return { ...r, meta: { changes: Number(r.changes) } }; },
        sql, params,
      });
      return statement([]);
    },
    // Session 211 (build plan 8): recordCorrection writes in one D1 batch; this is one transaction, as D1's batch is.
    async batch(stmts) {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => { log.push(s.sql); const r = raw.prepare(s.sql)[/^\s*SELECT/i.test(s.sql) ? "all" : "run"](...s.params); return { meta: { changes: Number(r?.changes ?? 0) } }; });
        raw.exec("COMMIT");
        return out;
      } catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
  return db;
}
// Session 211 (build plan 8): a correction now needs the correction-guard schema (a test fixture until the owner authorises
// the migration file) and the posted hash the route read; it returns { entry } or { refused }.
async function correct(db, puCode, tally) {
  if (!db.raw.prepare("SELECT 1 FROM pragma_table_info('unit_consensus') WHERE name = 'correction_hash'").get()) db.raw.exec(CORRECTION_GUARD_SCHEMA);
  db.raw.prepare("UPDATE unit_consensus SET ledger_hash = COALESCE(ledger_hash, 'posted-before') WHERE pu_code = ? AND race = 'president'").run(puCode);
  const { ledger_hash: expectedHash } = db.raw.prepare("SELECT ledger_hash FROM unit_consensus WHERE pu_code = ? AND race = 'president'").get(puCode);
  const out = await recordCorrection(db, { puCode, race: "president", tally, flagId: "f1", reason: "test", expectedHash });
  assert.ok(out.entry, JSON.stringify(out));
  return out.entry;
}
const addUnit = (db, pu, race, tally, { status = "high", updated = "2027-01-16T10:00:00.000Z", irev = null } = {}) =>
  db.raw.prepare("INSERT INTO unit_consensus (pu_code, race, status, share, reports, tally_json, discrepancy_json, updated_at) VALUES (?, ?, ?, 1, 3, ?, ?, ?) ON CONFLICT (pu_code, race) DO UPDATE SET status = excluded.status, tally_json = excluded.tally_json, updated_at = excluded.updated_at")
    .run(pu, race, status, tally ? JSON.stringify(tally) : null, irev ? JSON.stringify(irev) : null, updated);
const stored = (db, race = "president") => { const r = db.raw.prepare("SELECT * FROM results_snapshot WHERE race = ?").get(race); return r ? { ...r, body: JSON.parse(r.body_json) } : null; };
const request = (race = "president") => new Request(`https://example.test/api/results?race=${race}`);
const scan = async (db, race = "president") => (await onRequestGet({ request: request(race), env: { DB: db } })).json();
const read = (db, race = "president") => onRequestGet({ request: request(race), env: { DB: db, RESULTS_SOURCE: "snapshot" } });
const withoutTimes = ({ updatedAt, builtAt, statusCounts, ...rest }) => rest;   // statusCounts: stored for the press feed; the scan path never had it
const NOW =Date.parse("2027-01-16T10:05:00.000Z");
const clock = (at = NOW) => () => at;
const seed = (db) => {
  addUnit(db, "24-09-05-012", "president", { A: 10, AA: 3 });
  addUnit(db, "24-09-05-013", "president", { A: 1, AA: 9 }, { irev: { match: false } });
  addUnit(db, "24-10-01-001", "president", { A: 5, PA: 5 }, { irev: { match: true } });
  addUnit(db, "19-01-01-001", "president", { A: 7, ADC: 2 });
  addUnit(db, "37-01-01-001", "president", { AA: 4 });
  addUnit(db, "04-01-01-001", "governor", { A: 6 });   // Region AN: off-cycle for governorship
  addUnit(db, "37-01-01-002", "governor", { A: 6 });   // Capital Region: no governorship
  addUnit(db, "24-09-05-012", "governor", { A: 2, AA: 8 });
};

test("a body built a page at a time equals one built from all rows, at any page size", () => {
  const rows = [["24-09-05-012", { A: 10, AA: 3 }], ["24-09-05-013", { A: 1, AA: 9 }], ["24-10-01-001", { A: 5, PA: 5 }], ["19-01-01-001", { A: 7 }], ["37-01-01-001", { AA: 4 }]]
    .map(([pu_code, tally]) => ({ pu_code, tally_json: JSON.stringify(tally), discrepancy_json: null }));
  const whole = resultsAccumulator("president"); whole.add(rows);
  for (const size of [1, 2, 3, 5]) {
    const paged = resultsAccumulator("president");
    for (let i = 0; i < rows.length; i += size) paged.add(rows.slice(i, i + size));
    assert.deepEqual(paged.body(), whole.body(), `page size ${size}`);
  }
  const body = whole.body();
  assert.equal(body.units.reported, 5);
  assert.deepEqual(body.national.totals, { A: 23, AA: 16, PA: 5 });
  assert.equal(body.byLga["XL-LA"]["24-09"].units, 2);
  assert.equal(body.byLga["XL-LA"]["24-10"].leader.tie, true, "leaders come from the summed totals, not from one page");
});

test("the accumulator applies the same eligibility as the live query", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "governor", { now: clock() });
  const snap = stored(db, "governor");
  assert.deepEqual(Object.keys(snap.body.byState), ["XL-LA"]);
  assert.deepEqual(withoutTimes(snap.body), withoutTimes(await scan(db, "governor")));
});

test("a snapshot body equals the scan path's response apart from timestamps", async () => {
  const db = freshDb(); seed(db);
  for (const race of RESULTS_RACES) {
    await buildRace(db, race, { now: clock() });
    assert.deepEqual(withoutTimes(JSON.parse(stored(db, race).body_json)), withoutTimes(await scan(db, race)), race);
  }
  const body = stored(db).body;
  assert.equal(body.irev.compared, 2); assert.equal(body.irev.mismatches, 1);
  assert.match(body.notice, /Not official results\. Only EEC declares results\./);
});

test("the reader makes exactly one query, on results_snapshot, and never touches unit_consensus", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "president", { now: () => Date.now() });
  db.log.length = 0;
  const response = await read(db);
  assert.equal(response.status, 200);
  assert.equal(db.log.length, 1);
  assert.match(db.log[0], /FROM results_snapshot WHERE race = \?1/);
  assert.doesNotMatch(db.log[0], /unit_consensus/);
});

test("a missing snapshot gives 503, no-store, and nothing is cached", async () => {
  const db = freshDb(); seed(db);
  const puts = [];
  globalThis.caches = { default: { match: async () => undefined, put: async (k) => { puts.push(k.url); } } };
  try {
    const response = await read(db);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(puts, []);
    assert.equal((await onRequestGet({ request: request(), env: { RESULTS_SOURCE: "snapshot" } })).status, 503, "no database binding");
    assert.ok(db.log.every((sql) => !/unit_consensus/.test(sql)), "never falls back to a scan");
  } finally { delete globalThis.caches; }
});

test("a row older than the limit gets the same 503, so a stopped Worker cannot look fresh", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "president", { now: clock(Date.now() - SNAPSHOT_MAX_AGE_MS - 1000) });
  assert.equal((await read(db)).status, 503);
  await buildRace(db, "president", { now: clock(Date.now() - SNAPSHOT_MAX_AGE_MS + REBUILD_EVERY_MS + 60_000) });   // the forced rebuild
  assert.equal((await read(db)).status, 200);
  assert.ok(REBUILD_EVERY_MS * 2 <= SNAPSHOT_MAX_AGE_MS, "two forced rebuilds fit inside the limit");
});

test("a served snapshot adds builtAt and updatedAt at read time and is valid JSON", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "president", { now: () => Date.now() });
  const before = Date.now();
  const response = await read(db);
  assert.equal(response.headers.get("cache-control"), "public, max-age=15");
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.builtAt, stored(db).built_at);
  assert.ok(Date.parse(body.updatedAt) >= before);
  assert.deepEqual(Object.keys(body).slice(-2), ["builtAt", "updatedAt"]);
  assert.deepEqual(JSON.parse(servedBody('{"a":1}', "b", "c")), { a: 1, builtAt: "b", updatedAt: "c" });
});

test("a served snapshot is accepted by the page's feed", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "president", { now: () => Date.now() });
  const feed = createResultsFeed({ autoRefresh: false, fetchImpl: async () => read(db) });
  const state = await feed.ensure("president");
  assert.equal(state.status, "fresh");
  assert.equal(state.data.units.reported, 5);
  assert.deepEqual(state.data.national.totals, stored(db).body.national.totals);
  assert.deepEqual(Object.keys(state.data.byLga).sort(), ["XL-FC", "XL-KN", "XL-LA"]);
  const again = await feed.ensure("president", { force: true });
  assert.equal(again.status, "fresh", "a second read is not refused as older");
  assert.equal(again.contentRevision, state.contentRevision, "same counts stay a quiet refresh");
});

test("updatedAt comes from the read, so it does not go backwards when builds are older", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "president", { now: () => Date.now() - 300_000 });
  const first = await (await read(db)).json();
  await new Promise((r) => setTimeout(r, 5));
  const second = await (await read(db)).json();
  assert.ok(Date.parse(second.updatedAt) >= Date.parse(first.updatedAt));
  assert.ok(Date.parse(first.updatedAt) > Date.parse(first.builtAt));
});

test("the edge cache still fronts the snapshot path", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "president", { now: () => Date.now() });
  const store = new Map();
  globalThis.caches = { default: { match: async (k) => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r.clone()); } } };
  try {
    assert.equal((await read(db)).headers.get("x-binchika-cache"), "miss");
    db.log.length = 0;
    const hit = await read(db);
    assert.equal(hit.headers.get("x-binchika-cache"), "hit");
    assert.equal(db.log.length, 0);
    assert.equal((await hit.json()).units.reported, 5);
  } finally { delete globalThis.caches; }
});

test("an older build cannot overwrite a newer snapshot", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "president", { now: clock(NOW) });
  const newer = stored(db);
  addUnit(db, "24-09-05-014", "president", { A: 100 }, { updated: "2027-01-16T10:01:00.000Z" });
  await buildRace(db, "president", { now: clock(NOW - 30_000) });   // started earlier, finishes later
  assert.equal(stored(db).built_at, newer.built_at);
  assert.equal(stored(db).body.units.reported, newer.body.units.reported);
  await buildRace(db, "president", { now: clock(NOW + 60_000) });
  assert.equal(stored(db).body.units.reported, newer.body.units.reported + 1);
});

test("a unit changed behind the cursor during a build is corrected on the next tick", async () => {
  const db = freshDb(); seed(db);
  let changed = false;
  db.beforeAll = (sql, params) => {
    if (changed || !/pu_code > \?2/.test(sql) || params[1] === "") return;
    changed = true;   // the first page is already read: change a unit it covered
    addUnit(db, "19-01-01-001", "president", { A: 7000, ADC: 2 }, { updated: "2027-01-16T10:02:00.000Z" });
  };
  await buildRace(db, "president", { now: clock(NOW), pageSize: 1 });
  assert.ok(changed);
  assert.equal(stored(db).source_updated_at, "2027-01-16T10:00:00.000Z", "the watermark was read before page 1");
  assert.equal(stored(db).body.national.totals.A, 23);
  db.beforeAll = null;
  const next = await buildRace(db, "president", { now: clock(NOW + 60_000) });
  assert.equal(next.rebuilt, true);
  assert.equal(stored(db).body.national.totals.A, 7016);
  assert.deepEqual(withoutTimes(stored(db).body), withoutTimes(await scan(db)));
});

test("held and lower units never appear in a snapshot", async () => {
  const db = freshDb();
  addUnit(db, "24-09-05-012", "president", { A: 10 });
  addUnit(db, "24-09-05-013", "president", { A: 500 }, { status: "held" });
  addUnit(db, "24-09-05-014", "president", { A: 500 }, { status: "lower" });
  addUnit(db, "24-09-05-015", "president", { A: 500 }, { status: "medium" });
  addUnit(db, "24-09-05-016", "president", null);
  await buildRace(db, "president", { now: clock() });
  assert.equal(stored(db).body.units.reported, 1);
  assert.equal(stored(db).body.national.totals.A, 10);
});

test("a correction, and a change from high to held, cause a rebuild", async () => {
  const db = freshDb(); seed(db);
  db.raw.exec("UPDATE unit_consensus SET updated_at = '2020-01-01T00:00:00.000Z'");   // recordCorrection stamps today, which must be newest
  await buildRace(db, "president", { now: clock() });
  addUnit(db, "19-01-01-001", "president", { A: 7, ADC: 2 }, { status: "held", updated: "2020-01-01T00:03:00.000Z" });
  assert.equal((await buildRace(db, "president", { now: clock(NOW + 60_000) })).rebuilt, true);
  assert.equal(stored(db).body.units.reported, 4);
  await correct(db, "24-09-05-012", { A: 1, AA: 3 });
  assert.equal((await buildRace(db, "president", { now: clock(NOW + 120_000) })).rebuilt, true);
  assert.equal(stored(db).body.byLga["XL-LA"]["24-09"].totals.A, 2);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get().n, 1, "the builder adds nothing to the ledger; only the correction does");
});

test("a falling or empty MAX still rebuilds", async () => {
  const db = freshDb();
  addUnit(db, "24-09-05-012", "president", { A: 10 }, { updated: "2027-01-16T10:04:00.000Z" });
  await buildRace(db, "president", { now: clock() });
  db.raw.exec("DELETE FROM unit_consensus");
  assert.equal((await buildRace(db, "president", { now: clock(NOW + 60_000) })).rebuilt, true);
  assert.equal(stored(db).body.units.reported, 0);
  assert.equal(stored(db).source_updated_at, null);
});

test("an unchanged race does no paging, until the forced rebuild", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "president", { now: clock() });
  db.log.length = 0;
  assert.equal((await buildRace(db, "president", { now: clock(NOW + 60_000) })).rebuilt, false);
  assert.ok(db.log.every((sql) => !/pu_code > \?2/.test(sql)));
  assert.equal(db.log.length, 2);
  assert.equal((await buildRace(db, "president", { now: clock(NOW + REBUILD_EVERY_MS) })).rebuilt, true);
  assert.equal(stored(db).built_at, new Date(NOW + REBUILD_EVERY_MS).toISOString(), "so built_at proves the Worker is alive");
});

test("every race gets a row even with no reports", async () => {
  const db = freshDb();
  await runAll({ DB: db }, { now: clock(), log: () => {} });
  assert.deepEqual(db.raw.prepare("SELECT race FROM results_snapshot ORDER BY race").all().map((r) => r.race), [...RESULTS_RACES].sort());
  for (const race of RESULTS_RACES) {
    const snap = stored(db, race);
    assert.equal(snap.units, 0); assert.equal(snap.body.units.reported, 0); assert.equal(snap.body.race, race);
    assert.equal(snap.format, RESULTS_BODY_VERSION);
  }
});

test("a changed body version causes a rebuild", async () => {
  const db = freshDb(); seed(db);
  await buildRace(db, "president", { now: clock() });
  db.raw.exec("UPDATE results_snapshot SET format = format - 1");
  assert.equal((await buildRace(db, "president", { now: clock(NOW + 60_000) })).rebuilt, true);
  assert.equal(stored(db).format, RESULTS_BODY_VERSION);
});

test("one race failing does not stop the others, and the run reports failure", async () => {
  const db = freshDb(); seed(db);
  const realPrepare = db.prepare;
  const lines = [];
  db.prepare = (sql) => { const s = realPrepare(sql); return { bind: (...v) => { if (v[0] === "senate") throw new Error("boom"); return s.bind(...v); } }; };
  await assert.rejects(runAll({ DB: db }, { now: clock(), log: (l) => lines.push(l) }), /senate/);
  db.prepare = realPrepare;
  assert.equal(stored(db, "senate"), null);
  for (const race of RESULTS_RACES.filter((r) => r !== "senate")) assert.ok(stored(db, race), race);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /pu_code|tally/);
});

test("the new queries use index searches, not scans", () => {
  const { raw } = freshDb();
  const plan = (sql, ...params) => raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((p) => p.detail).join(" / ");
  assert.match(plan("SELECT body_json, built_at FROM results_snapshot WHERE race = ?1", "president"), /^SEARCH results_snapshot/);
  assert.match(plan("SELECT MAX(updated_at) AS latest FROM unit_consensus WHERE race = ?1", "president"), /COVERING INDEX idx_unit_consensus_race_updated/);
  assert.match(plan("SELECT pu_code, tally_json, discrepancy_json FROM unit_consensus WHERE race = ?1 AND status = 'high' AND tally_json IS NOT NULL AND pu_code > ?2 ORDER BY pu_code LIMIT ?3", "president", "", 2000), /SEARCH unit_consensus USING INDEX idx_unit_consensus_race_status/);
});


// Session 112: /api/press/snapshot reads the same stored rows. docs/egm/press-snapshot-stored-rows/build-plan.md
const pressRequest = (race = "president", extra = "") => new Request(`https://example.test/api/press/snapshot?race=${race}${extra}`);
const pressRead = (db, race, extra) => pressGet({ request: pressRequest(race, extra), env: { DB: db, RESULTS_SOURCE: "snapshot" } });
const pressScan = (db, race) => pressGet({ request: pressRequest(race), env: { DB: db } });
const freshBuild = (db, race = "president") => buildRace(db, race, { now: () => Date.now() });
const seedMixed = (db) => {
  seed(db);
  addUnit(db, "24-09-05-020", "president", { A: 500 }, { status: "held" });
  addUnit(db, "24-09-05-021", "president", { A: 500 }, { status: "held" });
  addUnit(db, "24-09-05-022", "president", { A: 500 }, { status: "lower" });
  addUnit(db, "24-09-05-023", "president", { A: 500 }, { status: "medium" });
  addUnit(db, "24-09-05-024", "president", null, { status: "insufficient" });
  addUnit(db, "24-09-05-025", "president", null);   // high with no tally: not published, so not yet high
  addUnit(db, "04-01-01-002", "governor", { A: 500 }, { status: "lower" });   // ineligible state, still counted by status
  addUnit(db, "99-01-01-001", "president", { A: 500 });   // no such state: not published
};

test("the press document from a stored row equals the scan's, apart from updatedAt", async () => {
  const db = freshDb(); seedMixed(db);
  for (const race of RESULTS_RACES) {
    await freshBuild(db, race);
    const { updatedAt: a, figuresBuiltAt: builtA, ...fromRow } = await (await pressRead(db, race)).json();
    const { updatedAt: b, figuresBuiltAt: builtB, ...fromScan } = await (await pressScan(db, race)).json();
    assert.deepEqual(fromRow, fromScan, race);
    assert.ok(Date.parse(builtA) && Date.parse(builtB), `${race}: both paths state when the figures were built`);
    assert.deepEqual(Object.keys(fromRow), Object.keys(fromScan), `${race}: top-level order`);
    assert.ok(Date.parse(a) && Date.parse(b));
  }
  const president = await (await pressRead(db)).json();
  assert.deepEqual([president.units.published, president.units.lowerConfidence, president.units.held, president.units.notYetHigh], [5, 1, 2, 4]);
  assert.deepEqual(president.irev, { compared: 2, mismatches: 1 });
  const governor = await (await pressRead(db, "governor")).json();
  assert.deepEqual([governor.units.published, governor.units.lowerConfidence, governor.units.notYetHigh], [1, 1, 2], "off-cycle and Capital Region units are not published, as today");
});

test("the press document keeps its exact keys and carries nothing from the results body", async () => {
  const db = freshDb(); seedMixed(db);
  await freshBuild(db);
  const text = await (await pressRead(db)).text();
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc), ["notice", "race", "updatedAt", "figuresBuiltAt", "ledger", "units", "national", "byState", "irev", "rules"]);
  assert.deepEqual(Object.keys(doc.ledger), ["head", "count", "verify"]);
  assert.deepEqual(Object.keys(doc.units), ["published", "lowerConfidence", "held", "notYetHigh", "denominator", "denominatorSource"]);
  assert.deepEqual(Object.keys(doc.national), ["totals"]);
  assert.deepEqual(Object.keys(doc.irev), ["compared", "mismatches"]);
  for (const area of Object.values(doc.byState)) assert.deepEqual(Object.keys(area), ["units", "totals"]);
  assert.equal(doc.notice, PRESS_NOTICE);
  assert.equal(doc.units.denominator, 12000);
  assert.equal(doc.units.denominatorSource, "Example figure: fictional");
  assert.match(doc.rules, /^Lower-confidence and held units are not in the totals\./);
  for (const word of ["leader", "spread", "byLga", "builtAt", "statusCounts", '"note"', "high confidence only", "reported"]) assert.ok(!text.includes(word), word);
});

test("a press request reads the stored row and the ledger head, and never unit_consensus", async () => {
  const db = freshDb(); seedMixed(db);
  await freshBuild(db);
  db.log.length = 0;
  assert.equal((await pressRead(db)).status, 200);
  assert.equal(db.log.length, 2);
  assert.match(db.log[0], /FROM results_snapshot WHERE race = \?1/);
  assert.match(db.log[1], /FROM ledger_entries/);
  assert.ok(db.log.every((sql) => !/unit_consensus/.test(sql)));
});

test("the press reader's queries and the status count do not scan", async () => {
  const db = freshDb(); seedMixed(db);
  await freshBuild(db);
  const built = db.log.find((sql) => /GROUP BY status/.test(sql));
  assert.ok(built, "the Worker ran the status count");
  db.log.length = 0;
  await pressRead(db);
  for (const sql of [...db.log, built]) {
    const plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.includes("?1") ? ["president"] : [])).map((p) => p.detail).join(" / ");
    assert.match(plan, /SEARCH/, sql);
    assert.doesNotMatch(plan, /\bSCAN\b/, sql);
  }
  assert.match(db.raw.prepare(`EXPLAIN QUERY PLAN ${built}`).all("president").map((p) => p.detail).join(""), /COVERING INDEX idx_unit_consensus_race_status/);
});

test("a missing, old or older-format row gives 503, no-store, CORS, nothing cached and no scan", async () => {
  const db = freshDb(); seedMixed(db);
  const puts = [];
  globalThis.caches = { default: { match: async () => undefined, put: async (k) => { puts.push(k.url); } } };
  const refused = async (response, label) => {
    assert.equal(response.status, 503, label);
    assert.equal(response.headers.get("cache-control"), "no-store", label);
    assert.equal(response.headers.get("access-control-allow-origin"), "*", label);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
    assert.deepEqual(await response.json(), { error: "results temporarily unavailable" }, label);
  };
  try {
    await refused(await pressRead(db), "no row");
    await buildRace(db, "president", { now: clock(Date.now() - SNAPSHOT_MAX_AGE_MS - 1000) });
    await refused(await pressRead(db), "row too old");
    await freshBuild(db);
    db.raw.exec("UPDATE results_snapshot SET body_json = json_remove(body_json, '$.statusCounts')");
    await refused(await pressRead(db), "row from an older Worker");
    await refused(await pressGet({ request: pressRequest(), env: { RESULTS_SOURCE: "snapshot" } }), "no binding");
    assert.deepEqual(puts, []);
    db.log.length = 0;
    await pressRead(db);
    assert.ok(db.log.every((sql) => !/unit_consensus/.test(sql)), "never falls back to a scan");
  } finally { delete globalThis.caches; }
});

test("the edge cache fronts the press path", async () => {
  const db = freshDb(); seedMixed(db);
  await freshBuild(db);
  const store = new Map();
  globalThis.caches = { default: { match: async (k) => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r.clone()); } } };
  try {
    const first = await pressRead(db);
    assert.equal(first.headers.get("x-binchika-cache"), "miss");
    const body = await first.text();
    assert.deepEqual([...store.keys()], ["https://binchika.com/api/press/snapshot?race=president"], "same key as before");
    db.log.length = 0;
    const hit = await pressRead(db);
    assert.equal(hit.headers.get("x-binchika-cache"), "hit");
    assert.equal(hit.headers.get("access-control-allow-origin"), "*");
    assert.equal(await hit.text(), body);
    assert.equal(await (await pressRead(db, "president", "&bust=1")).text(), body, "an added parameter gets the same copy");
    assert.equal(db.log.length, 0);
    const bad = await pressRead(db, "winner");
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "unknown race" });
    assert.equal(store.size, 1, "an unknown race is not stored");
  } finally { delete globalThis.caches; }
});

test("a press response keeps its headers and states which build its figures came from", async () => {
  const db = freshDb(); seedMixed(db);
  await freshBuild(db);
  const response = await pressRead(db);
  assert.equal(response.headers.get("cache-control"), "public, max-age=15");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("x-binchika-figures-built"), stored(db).built_at);
  const before = Date.now();
  assert.ok(Date.parse((await (await pressRead(db)).json()).updatedAt) >= before, "updatedAt is when this copy was made");
});

// Session 114: figuresBuiltAt, so a desk can detect frozen figures. docs/egm/media-freshness/build-plan.md
test("figuresBuiltAt on a press response equals the stored built_at", async () => {
  const db = freshDb(); seedMixed(db);
  await freshBuild(db);
  const doc = await (await pressRead(db)).json();
  assert.equal(doc.figuresBuiltAt, stored(db).built_at);
  assert.ok(Date.parse(doc.updatedAt) >= Date.parse(doc.figuresBuiltAt));
  await buildRace(db, "president", { now: clock(Date.now() + REBUILD_EVERY_MS) });
  assert.equal((await (await pressRead(db)).json()).figuresBuiltAt, stored(db).built_at, "it follows the next build");
});

test("the scan path's figuresBuiltAt is when the copy was made, because the figures are built then", async () => {
  const db = freshDb(); seedMixed(db);
  const doc = await (await pressScan(db)).json();
  assert.equal(doc.figuresBuiltAt, doc.updatedAt);
  assert.deepEqual(Object.keys(doc).slice(2, 4), ["updatedAt", "figuresBuiltAt"]);
});

test("a freeze shows as a growing gap on the press feed, and the 503 still starts at 20 minutes", async () => {
  const db = freshDb(); seedMixed(db);
  const gap = (doc) => Date.parse(doc.updatedAt) - Date.parse(doc.figuresBuiltAt);
  await buildRace(db, "president", { now: clock(Date.now() - 9 * 60_000) });
  assert.ok(gap(await (await pressRead(db)).json()) < 12 * 60_000, "a row between forced rebuilds does not look frozen");
  await buildRace(db, "president", { now: clock(Date.now() - 13 * 60_000 + 60_000) });
  db.raw.exec(`UPDATE results_snapshot SET built_at = '${new Date(Date.now() - 13 * 60_000).toISOString()}'`);
  const frozen = await pressRead(db);
  assert.equal(frozen.status, 200);
  assert.ok(gap(await frozen.json()) > 12 * 60_000, "a stopped Worker shows before the error");
  db.raw.exec(`UPDATE results_snapshot SET built_at = '${new Date(Date.now() - SNAPSHOT_MAX_AGE_MS - 1000).toISOString()}'`);
  const refused = await pressRead(db);
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).figuresBuiltAt, undefined);
  assert.ok(12 * 60_000 > REBUILD_EVERY_MS + 60_000, "the threshold allows the forced rebuild and one tick");
});

test("the ledger head on a press response is live, without a rebuild", async () => {
  const db = freshDb(); seedMixed(db);
  await freshBuild(db);
  const empty = await (await pressRead(db)).json();
  assert.deepEqual([empty.ledger.head, empty.ledger.count], [null, 0]);
  const entry = await correct(db, "24-09-05-012", { A: 1, AA: 3 });
  const after = await (await pressRead(db)).json();
  assert.deepEqual([after.ledger.head, after.ledger.count], [entry.hash, 1]);
  assert.equal(after.ledger.verify, "https://binchika.com/ledger/");
  assert.deepEqual(after.national, empty.national, "totals wait for the Worker");
});

test("status counts are stored, and a change between lower and held causes a rebuild", async () => {
  const db = freshDb(); seedMixed(db);
  await buildRace(db, "president", { now: clock() });
  assert.deepEqual(stored(db).body.statusCounts, { lowerConfidence: 1, held: 2, notYetHigh: 4 });
  assert.equal(stored(db).format, 2);
  addUnit(db, "24-09-05-022", "president", { A: 500 }, { status: "held", updated: "2027-01-16T10:03:00.000Z" });
  assert.equal((await buildRace(db, "president", { now: clock(NOW + 60_000) })).rebuilt, true);
  assert.deepEqual(stored(db).body.statusCounts, { lowerConfidence: 0, held: 3, notYetHigh: 4 });
  assert.equal(stored(db).body.units.reported, 5, "the totals do not move");
});

test("notYetHigh cannot go below zero if a unit changes during a build", async () => {
  assert.deepEqual(statusCounts([{ status: "lower", n: 1 }], 1), { lowerConfidence: 1, held: 0, notYetHigh: 0 });
  assert.deepEqual(statusCounts([{ status: "high", n: 5 }, { status: "medium", n: 2 }, { status: "someday", n: 1 }], 4), { lowerConfidence: 0, held: 0, notYetHigh: 4 }, "every status counts towards the whole");
  assert.deepEqual(statusCounts([], 0), { lowerConfidence: 0, held: 0, notYetHigh: 0 });
  const db = freshDb();
  addUnit(db, "24-09-05-012", "president", { A: 1 });
  addUnit(db, "24-09-05-013", "president", { A: 1 });
  let changed = false;
  db.beforeAll = (sql, params) => {
    if (changed || !/pu_code > \?2/.test(sql) || params[1] === "") return;
    changed = true;   // the first unit is already counted as published: move it to lower
    addUnit(db, "24-09-05-012", "president", { A: 1 }, { status: "lower", updated: "2027-01-16T10:02:00.000Z" });
  };
  await buildRace(db, "president", { now: clock(NOW), pageSize: 1 });
  assert.ok(changed);
  assert.deepEqual(stored(db).body.statusCounts, { lowerConfidence: 1, held: 0, notYetHigh: 0 });
  db.beforeAll = null;
  assert.equal((await buildRace(db, "president", { now: clock(NOW + 60_000) })).rebuilt, true);
  assert.equal(stored(db).body.units.reported, 1, "the next tick corrects it");
});

test("with RESULTS_SOURCE unset the press route still scans, unchanged", async () => {
  const db = freshDb(); seedMixed(db);
  const response = await pressScan(db);
  assert.equal(response.status, 200);
  assert.ok(db.log.some((sql) => /FROM unit_consensus WHERE race = \?1/.test(sql)));
  assert.ok(db.log.every((sql) => !/results_snapshot/.test(sql)), "no stored row is needed");
  assert.equal(response.headers.get("x-binchika-figures-built"), null);
  assert.equal(response.headers.get("cache-control"), "public, max-age=15");
  assert.equal((await response.json()).units.published, 5);
});

test("/api/results passes statusCounts through, and the page's feed treats a change in it as a quiet refresh", async () => {
  const db = freshDb(); seedMixed(db);
  await buildRace(db, "president", { now: clock(Date.now() - 60_000) });
  assert.deepEqual((await (await read(db)).json()).statusCounts, { lowerConfidence: 1, held: 2, notYetHigh: 4 });
  const feed = createResultsFeed({ autoRefresh: false, fetchImpl: async () => read(db) });
  const first = await feed.ensure("president");
  assert.equal(first.status, "fresh");
  addUnit(db, "24-09-05-022", "president", { A: 500 }, { status: "held", updated: "2027-01-16T10:03:00.000Z" });
  await freshBuild(db);
  assert.deepEqual(stored(db).body.statusCounts, { lowerConfidence: 0, held: 3, notYetHigh: 4 });
  await new Promise((r) => setTimeout(r, 5));
  const second = await feed.ensure("president", { force: true });
  assert.equal(second.status, "fresh");
  assert.equal(second.contentRevision, first.contentRevision, "the page does not redraw or announce");
});
