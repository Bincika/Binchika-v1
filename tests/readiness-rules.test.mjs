import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseReport } from "../functions/_lib/report.js";
import { unitConsensus, compareWithOfficial } from "../functions/_lib/consensus.js";
import {
  NATIONAL_2023, illustrativeUnit, assessSheet, BALLOT_CASES, ballotVerdict,
  proposedPuProblem, ocrGate, proposalAllowed, FIELD_CONFIDENCE_MIN,
} from "../sandbox/readiness/ec8a-rules.mjs";

test("2023 declaration figures used as a labelled, unverified share source stay internally consistent", () => {
  assert.equal(NATIONAL_2023.verified, false);
  assert.equal(NATIONAL_2023.registered, 93469008);
  assert.equal(NATIONAL_2023.valid + NATIONAL_2023.rejected, NATIONAL_2023.cast);
  const four = Object.values(NATIONAL_2023.parties).reduce((a, n) => a + n, 0);
  assert.ok(four < NATIONAL_2023.valid, "other parties exist beyond the four named ones");
});

test("illustrative unit balances, and rejected ballots are not party votes", () => {
  const unit = illustrativeUnit();
  const assessed = assessSheet(unit);
  assert.equal(assessed.ok, true, assessed.errors.join("; "));
  assert.equal(assessed.valid, Object.values(unit.parties).reduce((a, n) => a + n, 0));
  assert.equal(assessed.cast, assessed.valid + unit.rejected);
  assert.ok(assessed.cast <= unit.accredited);
  assert.ok(unit.accredited <= unit.register);
  assert.equal(assessSheet({ ...unit, rejected: unit.rejected + 1, parties: { ...unit.parties, APC: unit.parties.APC + 1 } }).ok, false);
});

test("a cancelled unit is never eligible, even when the party numbers add up", () => {
  const unit = illustrativeUnit();
  const cancelled = assessSheet({ ...unit, cancelled: true });
  assert.equal(cancelled.eligible, false);
  assert.equal(cancelled.reason, "cancelled");
});

test("ballot conditions on /vote/ match the published captions and the classifier", () => {
  const page = readFileSync(new URL("../src/pages/vote.html", import.meta.url), "utf8");
  assert.equal(BALLOT_CASES.length, 6);
  for (const item of BALLOT_CASES) {
    assert.ok(page.includes(item.detail), item.detail);
    assert.equal(ballotVerdict(item), item.verdict);
  }
  assert.equal(ballotVerdict({ marks: 1, boxes: 1, identifies: false, outside: false }), "valid");
});

test("positional polling-unit checks reject state 00 and 99; since session 88 the live parser does too", () => {
  assert.equal(proposedPuProblem("37-01-01-901"), null);
  assert.equal(proposedPuProblem("24-09-05-012"), null);
  assert.equal(proposedPuProblem("00-00-00-000"), "state");
  assert.equal(proposedPuProblem("99-01-01-001"), "state");
  assert.equal(proposedPuProblem("37-00-01-001"), "position");
  assert.equal(proposedPuProblem("24-9-5-12"), "syntax");
  assert.equal(proposedPuProblem("24-09-05-012; DROP TABLE reports"), "syntax");
  // Session 88 closed the recorded gap: the live parser now refuses positional nonsense.
  for (const code of ["00-00-00-000", "99-99-99-999"]) assert.equal(parseReport({ channel: "web", handle: "sandbox", puCode: code, tally: { APC: 1 } }).ok, false, code);
  assert.equal(parseReport({ channel: "web", handle: "sandbox", puCode: "37-01-01-901", tally: { APC: 1 } }).ok, true);
  assert.equal(parseReport({ channel: "web", handle: "sandbox", puCode: "bad", tally: { APC: 1 } }).ok, false);
});

test("OCR below 0.9 stays with a person, and one confident read is still not a ledger write", () => {
  assert.equal(FIELD_CONFIDENCE_MIN, 0.9);
  const truth = illustrativeUnit().parties;
  const fields = Object.entries(truth).map(([name, n]) => ({ name, truth: n, read: n, confidence: 0.97 }));
  assert.equal(ocrGate(fields).eligible, true);
  fields[0].confidence = 0.89;
  assert.deepEqual(ocrGate(fields).low, ["APC"]);
  const sheet = illustrativeUnit();
  assert.equal(proposalAllowed({ sheet, fields }).allowed, false);
  const reports = [{ reporterHash: "only-one", tally: truth }];
  assert.notEqual(unitConsensus(reports).status, "high");
});

test("low agreement and alternative evidence never look like a ledger tally; an IReV mismatch is visible", () => {
  const tally = { APC: 10, PDP: 8 };
  const split = unitConsensus([
    { reporterHash: "a", tally },
    { reporterHash: "b", tally },
    { reporterHash: "c", tally: { APC: 1, PDP: 20 } },
  ]);
  assert.equal(split.status, "medium");
  assert.ok(split.share < 0.85);
  const lower = unitConsensus([
    { reporterHash: "a", tally, evidence: "board", audit: "approved" },
    { reporterHash: "b", tally, evidence: "handwritten", audit: "approved" },
    { reporterHash: "c", tally, evidence: "video", audit: "approved" },
  ]);
  assert.equal(lower.status, "lower");
  const diff = compareWithOfficial(tally, { APC: 10, PDP: 9 });
  assert.equal(diff.match, false);
  assert.deepEqual(diff.diffs, [{ party: "PDP", citizen: 8, official: 9, delta: -1 }]);
});
