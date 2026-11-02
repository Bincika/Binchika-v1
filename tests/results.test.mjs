import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, leader, spread, twoThirds, stateOfPu } from "../functions/_lib/results.js";
import * as results from "../functions/_lib/results.js";
import { onRequestGet } from "../functions/api/results.js";
import { readFile } from "node:fs/promises";

test("PU code prefix maps to state (Lagos 24, FCT 37), junk maps to null", () => {
  assert.equal(stateOfPu("24-09-05-012"), "NG-LA");
  assert.equal(stateOfPu("37-01-01-001"), "NG-FC");
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
  assert.deepEqual(a.byState["NG-LA"], { units: 2, totals: { X: 11, Y: 14 } });
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

test("LGA aggregates use numeric state-LGA prefixes and skip malformed PU codes", () => {
  assert.equal(typeof results.aggregateByLga, "function");
  const grouped = results.aggregateByLga([
    { pu_code: "24-09-05-012", tally: { X: 10, Y: 3 } },
    { pu_code: "24-09-05-013", tally: { X: 1, Y: 8 } },
    { pu_code: "24-10-01-001", tally: { Y: 7 } },
    { pu_code: "37-01-01-001", tally: { X: 4 } },
    { pu_code: "24-garbage", tally: { X: 99 } },
    { pu_code: "99-01-01-001", tally: { X: 99 } },
  ]);
  assert.deepEqual(grouped["NG-LA"]["24-09"], { units: 2, totals: { X: 11, Y: 11 }, leader: { party: null, tie: true, votes: 11 } });
  assert.equal(grouped["NG-LA"]["24-10"].units, 1);
  assert.equal(grouped["NG-FC"]["37-01"].leader.party, "X");
  assert.deepEqual(Object.keys(grouped["NG-LA"]), ["24-09", "24-10"]);
});

test("results API adds LGA totals without changing national aggregation", async () => {
  const rows = [{ pu_code: "24-09-05-012", tally_json: JSON.stringify({ X: 10, Y: 3 }) }];
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } };
  const response = await onRequestGet({ request: new Request("https://example.test/api/results?race=president"), env });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.national.totals, { X: 10, Y: 3 });
  assert.deepEqual(payload.byLga?.["NG-LA"]?.["24-09"], { units: 1, totals: { X: 10, Y: 3 }, leader: leader({ X: 10, Y: 3 }) });
});

test("Nigeria 2027 eligibility matches race metadata and excludes FCT from state races", async () => {
  assert.equal(typeof results.eligibleStateForRace, "function");
  const { races } = JSON.parse(await readFile(new URL("../site/data/races.json", import.meta.url), "utf8"));
  const states = Object.values(results.INEC_STATE_CODE);
  for (const race of ["president", "senate", "house"]) assert.equal(states.filter((iso) => results.eligibleStateForRace(race, iso)).length, 37);
  assert.equal(states.filter((iso) => results.eligibleStateForRace("governor", iso)).length, 28);
  assert.equal(states.filter((iso) => results.eligibleStateForRace("state-assembly", iso)).length, 36);
  for (const iso of states) {
    assert.equal(results.eligibleStateForRace("governor", iso), iso !== "NG-FC" && !races.governor.offCycle.includes(iso));
    assert.equal(results.eligibleStateForRace("state-assembly", iso), iso !== "NG-FC");
  }
  assert.equal(results.eligibleStateForRace("local-government", "NG-LA"), false);
  assert.equal(results.eligibleStateForRace("unknown", "NG-LA"), false);
  assert.equal(results.eligibleStateForRace("president", "NG-XX"), false);
});

test("API totals and LGA groups include only jurisdictions eligible for the current race", async () => {
  const rows = Object.keys(results.INEC_STATE_CODE).map((code) => ({ pu_code: `${code}-01-01-001`, tally_json: JSON.stringify({ X: 1 }) }));
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
