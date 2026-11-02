import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAgainstBaseline, lgaKey } from "../functions/_lib/baseline.js";

test("user's example: 100k baseline announced as 110k is critical (an increase)", () => {
  const r = checkAgainstBaseline(100000, { registered: 110000 });
  assert.equal(r.severity, "critical");
  assert.deepEqual(r.findings[0], { field: "registered", baseline: 100000, announced: 110000, delta: 10000, pct: 10, reason: "Registered voters changed after the register was frozen" });
});

test("tiny clerical difference below threshold is not flagged", () => {
  assert.equal(checkAgainstBaseline(100000, { registered: 100300 }).severity, "none");
});

test("a material decrease is flagged as material, not critical", () => {
  const r = checkAgainstBaseline(100000, { registered: 98000 });
  assert.equal(r.severity, "material");
  assert.equal(r.findings[0].pct, -2);
});

test("votes cast or accredited above the register is always critical", () => {
  const r = checkAgainstBaseline(1000, { registered: 1000, accredited: 1001, votesCast: 990 });
  assert.equal(r.severity, "critical");
  assert.deepEqual(r.findings.map((f) => f.field), ["accredited"]);
});

test("missing baseline never flags", () => {
  assert.equal(checkAgainstBaseline(undefined, { registered: 5 }).severity, "none");
});

test("LGA name normalisation bridges INEC and GRID3 spellings", () => {
  assert.equal(lgaKey("KOLOKUMA/ OPOKUMA"), lgaKey("Kolokuma/Opokuma"));
  assert.equal(lgaKey("Owerri Municipal LGA"), lgaKey("OWERRI MUNICIPAL"));
});
