import { test } from "node:test";
import assert from "node:assert/strict";
import { validateContact, subjectFor, NATURES } from "../functions/_lib/contact.js";

const now = 1_800_000_000_000;
const ok = { nature: "manifesto", name: "Ada", email: "ada@example.org", message: "Please find our full manifesto attached for review.", website: "", renderedAt: now - 10_000, files: [{ name: "m.pdf", type: "application/pdf", size: 900_000 }] };

test("a normal submission passes", () => assert.deepEqual(validateContact(ok, now), { ok: true, errors: [] }));
test("honeypot and too-fast submissions are rejected", () => {
  assert.ok(validateContact({ ...ok, website: "http://spam" }, now).errors.includes("spam"));
  assert.ok(validateContact({ ...ok, renderedAt: now - 500 }, now).errors.includes("too fast"));
});
test("nature, email, message length are enforced", () => {
  const r = validateContact({ ...ok, nature: "bribe", email: "nope", message: "short" }, now);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
});
test("attachment count, size and type limits", () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ name: `a${i}.png`, type: "image/png", size: 10 }));
  assert.ok(validateContact({ ...ok, files: many }, now).errors.some((e) => e.includes("at most")));
  assert.ok(validateContact({ ...ok, files: [{ name: "big.pdf", type: "application/pdf", size: 11 * 1024 * 1024 }] }, now).errors.some((e) => e.includes("10 MB")));
  assert.ok(validateContact({ ...ok, files: [{ name: "x.exe", type: "application/x-msdownload", size: 10 }] }, now).errors.some((e) => e.includes("x.exe")));
});
test("routing: manifesto from accounts@, errors from ops@; subject is labelled", () => {
  assert.match(NATURES.manifesto.from, /accounts@binchika\.com/);
  assert.match(NATURES.error.from, /ops@binchika\.com/);
  assert.match(subjectFor(ok), /^\[Binchika · Party manifesto or motto submission\] Please find our full manifesto attached for review\.$/);
});
