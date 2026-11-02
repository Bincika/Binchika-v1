import { test } from "node:test";
import assert from "node:assert/strict";
import { isLockedAdminEmail, SUPERADMIN_EMAIL_SHA256 } from "../functions/_lib/supa.js";
import { inviteCode, opsAppointed } from "../functions/_lib/emails.js";

test("lock: only the owner's address (any case, spaces trimmed) is the BinchikAdmin address", async () => {
  assert.match(SUPERADMIN_EMAIL_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(await isLockedAdminEmail(" Admin@Example.org "), true);
  for (const other of ["admin@example.or", "admim@example.org", "noreply@binchika.com", "", null]) assert.equal(await isLockedAdminEmail(other), false, String(other));
});

test("emails: SZV / NRV codes offer a choice of seat; a specific-seat code names the seat", () => {
  const pick = inviteCode({ code: "K7QM-4XPD", seat: null, area: "Lagos", hours: 24, link: "https://binchika.com/join/", kind: "szv", openSeats: 2 });
  assert.match(pick.html, /any open <strong>SZV<\/strong> seat for <strong>Lagos<\/strong> \(2 open/);
  assert.doesNotMatch(pick.html, /null/);
  const nrv = inviteCode({ code: "K7QM-4XPD", seat: null, area: "South West", hours: 6, link: "x", kind: "nrv", openSeats: 3 });
  assert.match(nrv.html, /NRV seat · South West/);
  const one = inviteCode({ code: "K7QM-4XPD", seat: "SZV-073", area: "Lagos", hours: 24, link: "x" });
  assert.match(one.html, /offered seat <strong>SZV-073<\/strong>/);
});

test("emails: OpsAdmin appointment names the seat, demands MFA and says the address is locked", () => {
  const m = opsAppointed({ seat: "OPS-2", publicId: "V0009", link: "https://binchika.com/portal/#th=abc" });
  assert.equal(m.subject, "You have been appointed OpsAdmin OPS-2");
  assert.match(m.html, /authenticator app/);
  assert.match(m.html, /locked to seat OPS-2/);
  assert.match(m.html, /cannot approve corrections, release seats or invite verifiers/);
});
