import { test } from "node:test";
import assert from "node:assert/strict";
import { consensus, compareWithOfficial, tallyKey } from "../functions/_lib/consensus.js";

const r = (who, tally) => ({ reporterHash: who, tally });
const A = { APC: 120, LP: 80, PDP: 95 };

test("tallyKey ignores party order and zero counts", () => {
  assert.equal(tallyKey({ PDP: 95, APC: 120, LP: 80, YPP: 0 }), tallyKey(A));
});

test("no reports -> insufficient", () => {
  assert.equal(consensus([]).status, "insufficient");
});

test("3 of 3 agree -> high", () => {
  const c = consensus([r("a", A), r("b", A), r("c", { ...A })]);
  assert.equal(c.status, "high");
  assert.equal(c.share, 1);
  assert.deepEqual(c.tally, A);
});

test("2 agreeing reports are never high (minimum 3 independent)", () => {
  assert.equal(consensus([r("a", A), r("b", A)]).status, "medium");
});

test("exactly 85% agreement is high; just under is not", () => {
  const other = { APC: 121, LP: 80, PDP: 95 };
  const seventeen = Array.from({ length: 17 }, (_, i) => r("x" + i, A));
  const three = Array.from({ length: 3 }, (_, i) => r("y" + i, other));
  const c = consensus([...seventeen, ...three]); // 17/20 = 0.85
  assert.equal(c.status, "high");
  assert.equal(c.dissent.length, 1);
  const c2 = consensus([...seventeen.slice(0, 16), ...three, r("z", other)]); // 16/20 = 0.80
  assert.equal(c2.status, "medium");
});

test("duplicate reporter counts once (latest report wins)", () => {
  const c = consensus([r("a", { APC: 1 }), r("a", A), r("b", A), r("c", A)]);
  assert.equal(c.reports, 3);
  assert.equal(c.status, "high");
});

test("split reports -> low", () => {
  const c = consensus([r("a", A), r("b", { APC: 1 }), r("c", { LP: 4 })]);
  assert.equal(c.status, "low");
});

test("tie between top tallies is never resolved silently", () => {
  const c = consensus([r("a", A), r("b", A), r("c", { APC: 9 }), r("d", { APC: 9 })]);
  assert.equal(c.status, "low");
  assert.equal(c.tie, true);
});

test("compareWithOfficial lists every differing party with delta", () => {
  const res = compareWithOfficial(A, { APC: 120, LP: 70, PDP: 95, NNPP: 3 });
  assert.equal(res.match, false);
  assert.deepEqual(res.diffs, [
    { party: "LP", citizen: 80, official: 70, delta: 10 },
    { party: "NNPP", citizen: 0, official: 3, delta: -3 },
  ]);
  assert.equal(compareWithOfficial(A, { ...A }).match, true);
});
