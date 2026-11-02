import { test } from "node:test";
import assert from "node:assert/strict";
import { newCode, normCode, formatCode, isCodeShape, hashCode, hashToken, newToken, passwordProblem, normName } from "../functions/_lib/invites.js";
import { inviteCode, seatConfirmation, signInLink } from "../functions/_lib/emails.js";

test("codes: 8 symbols from the unambiguous alphabet, formatted XXXX-XXXX", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = newCode();
    assert.ok(isCodeShape(c), c);
    assert.doesNotMatch(c, /[01ILOU]/);
    seen.add(c);
  }
  assert.equal(seen.size, 2000, "no collisions in 2000 codes");
  assert.match(formatCode("K7QM4XPD"), /^K7QM-4XPD$/);
});

test("codes: typing variations normalise to the same hash; pepper and kind change it", async () => {
  assert.equal(normCode(" k7qm-4xpd "), "K7QM4XPD");
  const h = await hashCode("K7QM-4XPD", "pepper");
  assert.equal(await hashCode("k7qm 4xpd", "pepper"), h);
  assert.notEqual(await hashCode("K7QM-4XPD", "other"), h);
  assert.notEqual(await hashToken("K7QM4XPD", "pepper"), h, "code and token hashes are domain-separated");
  assert.match(h, /^[0-9a-f]{64}$/);
});

test("confirmation tokens: 43-char base64url, unique", () => {
  const a = newToken(), b = newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test("passwords: length, obvious choices and the email name are refused", () => {
  assert.match(passwordProblem("short", "a@b.c"), /12/);
  assert.match(passwordProblem("x".repeat(73), "a@b.c"), /72/);
  assert.match(passwordProblem("aaaaaaaaaaaaaa", "a@b.c"), /easy/);
  assert.match(passwordProblem("Password1234", "a@b.c"), /easy/);
  assert.match(passwordProblem("adebayo-is-me-2027", "adebayo@example.com"), /email/);
  assert.equal(passwordProblem("green mango under lagos rain", "adebayo@example.com"), null);
});

test("names: accents, case, spaces and hyphens are ignored (mirror of public.norm_name)", () => {
  assert.equal(normName("Adébáyọ̀ Ọlá-Ojo"), "adebayoolaojo");
  assert.equal(normName("adebayo ola ojo"), normName("ADEBAYO  OLA-OJO"));
  assert.notEqual(normName("Ola Adebayo Ojo"), normName("Adebayo Ola Ojo"), "word order still matters");
});

test("emails: invite code first in the subject, link to /join/, no name", () => {
  const m = inviteCode({ code: "K7QM-4XPD", seat: "SZV-073", area: "Lagos", hours: 24, link: "https://binchika.com/join/" });
  assert.match(m.subject, /^K7QM-4XPD is your Binchika seat code$/);
  assert.match(m.html, /https:\/\/binchika\.com\/join\//);
  assert.match(m.html, /SZV-073/);
  const c = seatConfirmation({ seat: "SZV-073", publicId: "V0002", area: "Lagos", link: "https://binchika.com/join/pledge/#t=abc" });
  assert.match(c.subject, /^Confirm seat SZV-073/);
  assert.match(c.html, /#t=abc/);
  assert.doesNotMatch(signInLink({ link: "https://x", reset: true }).html, /no passwords/);
});
