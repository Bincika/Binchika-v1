import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Session 97: GitHub Actions checks out one commit only (actions/checkout, fetch-depth 1). A test that reads git history
// (git show <old commit>:…, git log, HEAD~1) passes on a full local clone but fails in CI: that is what turned runs
// #101–#105 red. Compare with a stored SHA-256 instead (see tests/race-dashboard.test.mjs).
test("no test reads git history (CI uses a shallow checkout)", () => {
  const dir = new URL("./", import.meta.url);
  const offenders = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && f !== "ci-shallow.test.mjs")
    .filter((f) => /\b(execFileSync|execSync|spawnSync|spawn|exec)\(\s*['"]git['"]/.test(readFileSync(new URL(f, dir), "utf8")));
  assert.deepEqual(offenders, []);
});
