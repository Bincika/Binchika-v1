import { test } from "node:test";
import assert from "node:assert/strict";
import { screen, cleanAnswers, RULES } from "../functions/_lib/screening.js";

const GOOD = { q1: "no", q2: "no", q3: "no", q4: "no", q5: "yes", q6: "yes", q7: "yes", q8: "no" };

test("screening: all safe answers → eligible, same score for everyone", () => {
  assert.deepEqual(screen(GOOD), { status: "eligible", missing: [], reasons: [], score: 100 });
});

test("screening: each disqualifying answer is caught with its published reason", () => {
  for (const [q, bad, why] of RULES) {
    const v = screen({ ...GOOD, [q]: bad });
    assert.equal(v.status, "ineligible", q);
    assert.deepEqual(v.reasons, [why]);
  }
});

test("screening: 'not sure' on question 7 goes to human review, not straight in", () => {
  assert.equal(screen({ ...GOOD, q7: "unsure" }).status, "submitted");
  assert.equal(screen({ ...GOOD, q1: "unsure" }).status, "incomplete", "'unsure' is only allowed for q7");
});

test("screening: missing answers are reported; extra fields are dropped before storage", () => {
  const v = screen({ q1: "no" });
  assert.equal(v.status, "incomplete");
  assert.deepEqual(v.missing, ["q2", "q3", "q4", "q5", "q6", "q7", "q8"]);
  assert.deepEqual(Object.keys(cleanAnswers({ ...GOOD, bvn: "123", note: "x" })), RULES.map(([q]) => q));
});
