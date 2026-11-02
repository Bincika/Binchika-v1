import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, genesis, makeEntry, verifyChain } from "../functions/_lib/ledger.js";

test("canonical JSON is key-order independent", () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), canonical({ a: { c: [3, { e: 0, f: 1 }], d: 2 }, b: 1 }));
});

test("chain verifies, and tampering is detected at the right index", async () => {
  const g = await genesis("ng-2027");
  const e1 = await makeEntry({ id: "pu:1", tally: { A: 10 } }, g, "2027-01-16T18:00:00Z");
  const e2 = await makeEntry({ id: "pu:2", tally: { A: 7 } }, e1.hash, "2027-01-16T18:01:00Z");
  const e3 = await makeEntry({ id: "pu:3", tally: { A: 3 } }, e2.hash, "2027-01-16T18:02:00Z");
  assert.deepEqual(await verifyChain([e1, e2, e3], g), { ok: true, brokenAt: -1 });

  const forged = { ...e2, tally: { A: 70 } };
  assert.deepEqual(await verifyChain([e1, forged, e3], g), { ok: false, brokenAt: 1 });

  const reordered = [e1, e3, e2];
  assert.equal((await verifyChain(reordered, g)).brokenAt, 1);
});

test("genesis is deterministic per cycle", async () => {
  assert.equal(await genesis("ng-2027"), await genesis("ng-2027"));
  assert.notEqual(await genesis("ng-2027"), await genesis("gh-2028"));
});
