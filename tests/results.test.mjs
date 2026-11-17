import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, leader, spread, twoThirds, stateOfPu } from "../functions/_lib/results.js";
import * as results from "../functions/_lib/results.js";
import { onRequestGet } from "../functions/api/results.js";
import { readFile } from "node:fs/promises";

test("PU code prefix maps to state (Region LA 24, Capital Region 37), junk maps to null", () => {
  assert.equal(stateOfPu("24-09-05-012"), "XL-LA");
  assert.equal(stateOfPu("37-01-01-001"), "XL-FC");
  assert.equal(stateOfPu("99-01-01-001"), null);
});

test("aggregate sums by state and nationally; skips unknown state codes", () => {
  const a = aggregate([
    { pu_code: "24-01-01-001", tally: { X: 10, Y: 5 } },
    { pu_code: "24-01-01-002", tally: { X: 1, Y: 9 } },
    { pu_code: "19-01-01-001", tally: { Y: 3 } },
    { pu_code: "00-00-00-000", tally: { X: 999 } },
  ]);
  assert.equal(a.units, 3);
  assert.deepEqual(a.national, { X: 11, Y: 17 });
  assert.deepEqual(a.byState["XL-LA"], { units: 2, totals: { X: 11, Y: 14 } });
});

test("leader: none when empty, tie flagged, share and margin otherwise", () => {
  assert.equal(leader({}), null);
  assert.equal(leader({ X: 5, Y: 5 }).tie, true);
  assert.deepEqual(leader({ X: 6, Y: 2 }), { party: "X", votes: 6, share: 0.75, margin: 4 });
});

test("spread counts areas with at least 25% (boundary inclusive)", () => {
  assert.deepEqual(spread({ a: { X: 25, Y: 75 }, b: { X: 24, Y: 76 }, c: {} }), { X: 1, Y: 2 });
});

test("two-thirds rounds up", () => {
  assert.equal(twoThirds(36), 24);
  assert.equal(twoThirds(37), 25);
  assert.equal(twoThirds(44), 30);
  assert.equal(twoThirds(8), 6);
});

test("district aggregates use numeric state-district prefixes and skip malformed PU codes", () => {
  assert.equal(typeof results.aggregateByLga, "function");
  const grouped = results.aggregateByLga([
    { pu_code: "24-09-05-012", tally: { X: 10, Y: 3 } },
    { pu_code: "24-09-05-013", tally: { X: 1, Y: 8 } },
    { pu_code: "24-10-01-001", tally: { Y: 7 } },
    { pu_code: "37-01-01-001", tally: { X: 4 } },
    { pu_code: "24-garbage", tally: { X: 99 } },
    { pu_code: "99-01-01-001", tally: { X: 99 } },
  ]);
  assert.deepEqual(grouped["XL-LA"]["24-09"], { units: 2, totals: { X: 11, Y: 11 }, leader: { party: null, tie: true, votes: 11 } });
  assert.equal(grouped["XL-LA"]["24-10"].units, 1);
  assert.equal(grouped["XL-FC"]["37-01"].leader.party, "X");
  assert.deepEqual(Object.keys(grouped["XL-LA"]), ["24-09", "24-10"]);
});

test("results API adds district totals without changing national aggregation", async () => {
  const rows = [{ pu_code: "24-09-05-012", tally_json: JSON.stringify({ X: 10, Y: 3 }) }];
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } };
  const response = await onRequestGet({ request: new Request("https://example.test/api/results?race=president"), env });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.national.totals, { X: 10, Y: 3 });
  assert.deepEqual(payload.byLga?.["XL-LA"]?.["24-09"], { units: 1, totals: { X: 10, Y: 3 }, leader: leader({ X: 10, Y: 3 }) });
});

test("Exampleland 2027 eligibility matches race metadata and excludes Capital Region from state races", async () => {
  assert.equal(typeof results.eligibleStateForRace, "function");
  const { races } = JSON.parse(await readFile(new URL("../site/data/races.json", import.meta.url), "utf8"));
  const states = Object.values(results.STATE_CODE);
  for (const race of ["president", "senate", "house"]) assert.equal(states.filter((iso) => results.eligibleStateForRace(race, iso)).length, 37);
  assert.equal(states.filter((iso) => results.eligibleStateForRace("governor", iso)).length, 28);
  assert.equal(states.filter((iso) => results.eligibleStateForRace("state-assembly", iso)).length, 36);
  for (const iso of states) {
    assert.equal(results.eligibleStateForRace("governor", iso), iso !== "XL-FC" && !races.governor.offCycle.includes(iso));
    assert.equal(results.eligibleStateForRace("state-assembly", iso), iso !== "XL-FC");
  }
  assert.equal(results.eligibleStateForRace("local-government", "XL-LA"), false);
  assert.equal(results.eligibleStateForRace("unknown", "XL-LA"), false);
  assert.equal(results.eligibleStateForRace("president", "XL-XX"), false);
});

test("API totals and district groups include only jurisdictions eligible for the current race", async () => {
  const rows = Object.keys(results.STATE_CODE).map((code) => ({ pu_code: `${code}-01-01-001`, tally_json: JSON.stringify({ X: 1 }) }));
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } };
  for (const [race, expected] of [["president", 37], ["senate", 37], ["house", 37], ["governor", 28], ["state-assembly", 36]]) {
    const response = await onRequestGet({ request: new Request(`https://example.test/api/results?race=${race}`), env });
    const data = await response.json();
    assert.equal(data.units.reported, expected, race);
    assert.equal(data.national.totals.X, expected, race);
    assert.equal(Object.keys(data.byState).length, expected, race);
    assert.equal(Object.keys(data.byLga).length, expected, race);
  }
});

// Session 108: short edge cache. The stub stands in for caches.default, keyed by URL as the Cache API is.
const cacheStub = ({ failMatch = false, failPut = false } = {}) => {
  const store = new Map();
  return { store, puts: [],
    async match(key) { if (failMatch) throw new Error("cache read failed"); const hit = store.get(key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { if (failPut) throw new Error("cache write failed"); this.puts.push(key.url); store.set(key.url, response.clone()); },
  };
};
const countingDb = (rows = [{ pu_code: "24-09-05-012", tally_json: JSON.stringify({ X: 10, Y: 3 }) }]) => {
  const db = { reads: 0, prepare: () => ({ bind: () => ({ all: async () => { db.reads++; return { results: rows }; } }) }) };
  return db;
};
const get = (query, env, init) => onRequestGet({ request: new Request(`https://example.test/api/results${query}`, init), env });
async function withCache(cache, run) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { value: { default: cache }, configurable: true, writable: true });
  try { return await run(); } finally { if (had) Object.defineProperty(globalThis, "caches", had); else delete globalThis.caches; }
}

test("a second request within the TTL is served from the cache without reading D1", async () => {
  const cache = cacheStub(), DB = countingDb();
  await withCache(cache, async () => {
    const first = await get("?race=president", { DB });
    assert.equal(first.headers.get("x-binchika-cache"), "miss");
    const second = await get("?race=president", { DB });
    assert.equal(second.headers.get("x-binchika-cache"), "hit");
    assert.equal(DB.reads, 1);
    assert.equal(second.status, 200);
  });
});

test("a hit states its age so a browser cannot extend the lifetime", async () => {
  const cache = cacheStub(), DB = countingDb();
  await withCache(cache, async () => {
    const first = await get("?race=president", { DB });
    assert.equal(first.headers.get("age"), null);
    const built = Number(first.headers.get("x-binchika-built"));
    assert.ok(Number.isFinite(built));
    const original = Date.now;
    Date.now = () => built + 9_400;
    try { assert.equal((await get("?race=president", { DB })).headers.get("age"), "9"); } finally { Date.now = original; }
  });
});

test("each race has its own cache entry", async () => {
  const cache = cacheStub(), DB = countingDb();
  await withCache(cache, async () => {
    for (const race of ["president", "senate", "house", "governor", "state-assembly"]) assert.equal((await (await get(`?race=${race}`, { DB })).json()).race, race);
    assert.equal(DB.reads, 5);
    for (const race of ["president", "senate", "house", "governor", "state-assembly"]) {
      const again = await get(`?race=${race}`, { DB });
      assert.equal(again.headers.get("x-binchika-cache"), "hit", race);
      assert.equal((await again.json()).race, race);
    }
    assert.equal(DB.reads, 5);
  });
});

test("extra query parameters cannot force a fresh read", async () => {
  const cache = cacheStub(), DB = countingDb();
  await withCache(cache, async () => {
    await get("?race=senate", { DB });
    assert.equal((await get("?race=senate&x=1", { DB })).headers.get("x-binchika-cache"), "hit");
    assert.equal((await get("?x=2&race=senate", { DB })).headers.get("x-binchika-cache"), "hit");
    assert.equal(DB.reads, 1);
    assert.deepEqual(cache.puts, ["https://example.test/api/results?race=senate"]);
  });
});

test("the default race and an explicit president share one entry", async () => {
  const cache = cacheStub(), DB = countingDb();
  await withCache(cache, async () => {
    await get("", { DB });
    assert.equal((await get("?race=president", { DB })).headers.get("x-binchika-cache"), "hit");
    assert.equal(DB.reads, 1);
  });
});

test("an unknown race is refused before the cache and never stored", async () => {
  const cache = cacheStub(), DB = countingDb();
  await withCache(cache, async () => {
    for (let i = 0; i < 2; i++) assert.equal((await get("?race=winner", { DB })).status, 400);
    assert.equal(DB.reads, 0); assert.equal(cache.store.size, 0);
  });
});

test("a D1 failure is not stored and the next request recovers", async () => {
  const cache = cacheStub(), DB = countingDb();
  const failing = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("D1 down"); } }) }) };
  await withCache(cache, async () => {
    await assert.rejects(get("?race=president", { DB: failing }), /D1 down/);
    assert.equal(cache.store.size, 0);
    const next = await get("?race=president", { DB });
    assert.equal(next.status, 200); assert.equal(next.headers.get("x-binchika-cache"), "miss");
  });
});

test("a missing database binding is not stored", async () => {
  const cache = cacheStub(), DB = countingDb();
  await withCache(cache, async () => {
    const empty = await get("?race=president", {});
    assert.equal(empty.status, 200); assert.equal((await empty.json()).units.reported, 0);
    assert.equal(cache.store.size, 0);
    assert.equal((await (await get("?race=president", { DB })).json()).units.reported, 1, "real figures are not hidden by the fault");
  });
});

test("a cache that throws on read or write never fails the request", async () => {
  const DB = countingDb();
  for (const faults of [{ failMatch: true }, { failPut: true }]) {
    await withCache(cacheStub(faults), async () => {
      const response = await get("?race=president", { DB });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).units.reported, 1);
    });
  }
});

test("an Authorization header gets the same shared response", async () => {
  const cache = cacheStub(), DB = countingDb();
  await withCache(cache, async () => {
    const plain = await (await get("?race=president", { DB })).text();
    const signed = await get("?race=president", { DB }, { headers: { authorization: "Bearer test-value" } });
    assert.equal(signed.headers.get("x-binchika-cache"), "hit", "a header is not a way round the cache to D1");
    assert.equal(await signed.text(), plain);
    assert.equal(DB.reads, 1);
  });
});

test("the cache lifetime matches the browser max-age and stays within the page's poll", async () => {
  const { RESULTS_CACHE_SECONDS } = await import("../functions/_lib/edge-cache.js");
  assert.equal(RESULTS_CACHE_SECONDS, 15);
  assert.ok(RESULTS_CACHE_SECONDS <= 30);
  const response = await get("?race=president", { DB: countingDb() });
  assert.equal(response.headers.get("cache-control"), `public, max-age=${RESULTS_CACHE_SECONDS}`);
});

test("the served body and notice are the same on a hit and a miss", async () => {
  const cache = cacheStub(), DB = countingDb();
  await withCache(cache, async () => {
    const miss = await (await get("?race=president", { DB })).text();
    const hit = await (await get("?race=president", { DB })).text();
    assert.equal(hit, miss);
    assert.match(JSON.parse(hit).notice, /Not official results\. Only EEC declares results\./);
  });
});
