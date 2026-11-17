// Session 134: the BinchikAdmin review panel for applications stored for review (status 'submitted').
// Build plan: docs/egm/application-review/build-plan.md (on main). All Supabase, email and D1 calls are fakes here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { refOf, REVIEW_SELECT, INFO_SUBJECT, INFO_BODY, REJECT_REASON, listForReview, reviewAction } from "../functions/_lib/appreview.js";
import { applicationReviewed } from "../functions/_lib/emails.js";
import { RULES } from "../functions/_lib/screening.js";
import * as route from "../functions/api/admin/applications.js";

const ID = "3f2a91c0-1234-4abc-8def-000000000001";
const META = { states: [{ iso: "XL-LA", name: "Region LA" }, { iso: "XL-OY", name: "Region OY" }], verifierRegions: { regions: [{ id: "SW", name: "South West", states: ["XL-LA", "XL-OY"] }] } };
const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", RESEND_API_KEY: "test" };
const LOADED = /rigged|stolen|landslide|fraud|cheat/i;

// A fake D1: rows of { direction, subject, at }.
const fakeDB = (rows = []) => ({ prepare: (sql) => ({ bind: (...args) => ({
  all: async () => ({ results: rows.filter((r) => /subject LIKE/.test(sql)) }),
  first: async () => { const like = String(args[0] ?? "").replaceAll("%", ""); return rows.filter((r) => r.direction === "out" && r.subject.includes(like)).sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null; },
}) }) });

function deps({ rows = [], patchResult = [{ id: ID, email: "a@example.com", role_sought: "szv", state_iso: "XL-LA" }], emailOk = true, dash = { status: 200, body: { ok: true, id: "m1" } } } = {}) {
  const calls = { rest: [], email: [], dash: [] };
  return {
    calls,
    rest: async (_env, path, init = {}) => { calls.rest.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null }); return init.method === "PATCH" ? patchResult : rows; },
    sendEmail: async (_env, to, mail) => { calls.email.push({ to, mail }); return emailOk; },
    sendFromDashboard: async (_env, input, sender) => { calls.dash.push({ input, sender }); return dash; },
    meta: async () => META,
    now: () => new Date("2026-11-10T12:00:00Z"),
  };
}

test("refOf: 8 lowercase hex characters from a UUID; anything else is refused", () => {
  assert.equal(refOf(ID.toUpperCase()), "3f2a91c0");
  for (const bad of ["", "3f2a91c0", "not-a-uuid", null, undefined, `${ID}x`, "3f2a91c0-1234-4abc-8def-00000000000g"]) assert.equal(refOf(bad), null, String(bad));
});

test("list asks only for status 'submitted' and never selects a name, email, card or IP fingerprint", async () => {
  const d = deps({ rows: [{ id: ID, state_iso: "XL-LA", role_sought: "szv", answers: { q7: "unsure" }, created_at: "2026-11-10T10:00:00Z" }] });
  const r = await listForReview(env, d);
  assert.equal(d.calls.rest.length, 1);
  const p = d.calls.rest[0].path;
  assert.match(p, /^verifier_applications\?status=eq\.submitted&/);
  assert.ok(p.includes(`select=${REVIEW_SELECT}`));
  for (const f of ["full_name", "email", "vin_hash", "vin_last4", "ip_hash", "nin_hash"]) assert.ok(!REVIEW_SELECT.split(",").includes(f), f);
  assert.equal(r.applications[0].ref, "3f2a91c0");
  assert.equal(r.mailKnown, false, "no DB: request times are unknown, not 'never'");
  assert.equal(r.applications[0].infoRequestedAt, null);
});

test("list attaches the latest request and reply times by ref, from the dashboard mail", async () => {
  const d = deps({ rows: [{ id: ID, state_iso: "XL-LA", role_sought: "szv", answers: {}, created_at: "2026-11-10T10:00:00Z" }] });
  const DB = fakeDB([
    { direction: "out", subject: INFO_SUBJECT("3f2a91c0"), at: "2026-11-10T11:00:00Z" },
    { direction: "in", subject: `Re: ${INFO_SUBJECT("3f2a91c0")}`, at: "2026-11-10T11:30:00Z" },
    { direction: "in", subject: `Re: ${INFO_SUBJECT("3f2a91c0")}`, at: "2026-11-10T11:10:00Z" },
    { direction: "out", subject: INFO_SUBJECT("deadbeef"), at: "2026-11-10T11:50:00Z" },
  ]);
  const r = await listForReview({ ...env, DB }, d);
  assert.equal(r.mailKnown, true);
  assert.equal(r.applications[0].infoRequestedAt, "2026-11-10T11:00:00Z");
  assert.equal(r.applications[0].replyAt, "2026-11-10T11:30:00Z");
});

test("approve: one conditional PATCH to eligible with the common score, then an email", async () => {
  const d = deps();
  const r = await reviewAction(env, { action: "approve", applicationId: ID, actor: "V0001" }, d);
  assert.equal(r.status, 200);
  assert.equal(d.calls.rest.length, 1);
  assert.equal(d.calls.rest[0].method, "PATCH");
  assert.match(d.calls.rest[0].path, new RegExp(`^verifier_applications\\?id=eq\\.${ID}&status=eq\\.submitted&select=`));
  assert.deepEqual(d.calls.rest[0].body, { status: "eligible", score: 100 });
  assert.equal(d.calls.email.length, 1);
  assert.equal(d.calls.email[0].to, "a@example.com");
  assert.match(d.calls.email[0].mail.html, /3f2a91c0/);
  assert.equal(r.body.emailed, true);
  assert.ok(!JSON.stringify(r.body).includes("a@example.com"), "the response never carries the address");
});

test("approve or reject of an application no longer awaiting review: 409, no email", async () => {
  for (const action of ["approve", "reject"]) {
    const d = deps({ patchResult: [] });
    const r = await reviewAction(env, { action, applicationId: ID, actor: "V0001" }, d);
    assert.equal(r.status, 409, action);
    assert.equal(d.calls.email.length, 0, action);
  }
});

test("reject: keeps the row as ineligible with the published question 7 rule, then emails", async () => {
  const d = deps();
  const r = await reviewAction(env, { action: "reject", applicationId: ID, actor: "V0001" }, d);
  assert.equal(r.status, 200);
  assert.ok(d.calls.rest.every((c) => c.method !== "DELETE"), "never deleted: the unique email and card stay taken");
  assert.deepEqual(d.calls.rest[0].body, { status: "ineligible", ineligible_reasons: [REJECT_REASON] });
  assert.equal(REJECT_REASON, RULES.find(([q]) => q === "q7")[2]);
  assert.match(d.calls.email[0].mail.html, /whoever it helps/);
});

test("a failed decision email is reported, not hidden", async () => {
  const d = deps({ emailOk: false });
  const r = await reviewAction(env, { action: "approve", applicationId: ID, actor: "V0001" }, d);
  assert.equal(r.status, 200);
  assert.equal(r.body.emailed, false);
  assert.match(r.body.note, /email failed/i);
});

test("request info: from ops, ref in the subject, the fixed text; nothing written to Supabase", async () => {
  const d = deps({ rows: [{ id: ID, email: "a@example.com" }] });
  const r = await reviewAction({ ...env, DB: fakeDB([]) }, { action: "request_info", applicationId: ID, actor: "V0001" }, d);
  assert.equal(r.status, 200);
  assert.equal(d.calls.rest.length, 1);
  assert.equal(d.calls.rest[0].method, "GET");
  assert.match(d.calls.rest[0].path, /status=eq\.submitted&select=id,email$/);
  assert.equal(d.calls.dash.length, 1);
  const { input, sender } = d.calls.dash[0];
  assert.equal(input.from, "ops");
  assert.equal(input.to, "a@example.com");
  assert.equal(input.subject, "Your Binchika verifier application (ref 3f2a91c0): one question");
  assert.equal(input.body, INFO_BODY);
  assert.equal(sender, "V0001");
});

test("request info: refused within 48 hours of an earlier request; provider errors pass through", async () => {
  const recent = fakeDB([{ direction: "out", subject: INFO_SUBJECT("3f2a91c0"), at: "2026-11-09T20:00:00.000Z" }]);
  let d = deps({ rows: [{ id: ID, email: "a@example.com" }] });
  let r = await reviewAction({ ...env, DB: recent }, { action: "request_info", applicationId: ID, actor: "V0001" }, d);
  assert.equal(r.status, 409);
  assert.equal(d.calls.dash.length, 0);
  const old = fakeDB([{ direction: "out", subject: INFO_SUBJECT("3f2a91c0"), at: "2026-11-07T20:00:00.000Z" }]);
  for (const st of [429, 422, 502, 503]) {
    d = deps({ rows: [{ id: ID, email: "a@example.com" }], dash: { status: st, body: { error: "x" } } });
    r = await reviewAction({ ...env, DB: old }, { action: "request_info", applicationId: ID, actor: "V0001" }, d);
    assert.equal(r.status, st);
  }
  d = deps({ rows: [{ id: ID, email: "a@example.com" }] });
  r = await reviewAction(env, { action: "request_info", applicationId: ID, actor: "V0001" }, d);
  assert.equal(r.status, 503, "no dashboard mail: refused, nothing sent");
  assert.equal(d.calls.dash.length, 0);
  d = deps({ rows: [] });
  r = await reviewAction({ ...env, DB: fakeDB([]) }, { action: "request_info", applicationId: ID, actor: "V0001" }, d);
  assert.equal(r.status, 409, "not awaiting review");
});

test("unknown action or bad id: 422 and no call made", async () => {
  for (const [action, applicationId] of [["promote", ID], ["delete", ID], ["approve", "x"], ["reject", ""], [undefined, ID]]) {
    const d = deps();
    const r = await reviewAction(env, { action, applicationId, actor: "V0001" }, d);
    assert.equal(r.status, 422, `${action} ${applicationId}`);
    assert.equal(d.calls.rest.length + d.calls.email.length + d.calls.dash.length, 0);
  }
});

test("templates: ref, role and area; NRV uses the region; reject quotes the published rule; no names or loaded terms", () => {
  const a = applicationReviewed({ decision: "approved", role: "szv", area: "Region LA", ref: "3f2a91c0" });
  const j = applicationReviewed({ decision: "rejected", role: "nrv", area: "South West", ref: "3f2a91c0" });
  assert.match(a.subject, /reviewed/i);
  assert.match(a.html, /State Zone Verifier \(SZV\) · Region LA/);
  assert.match(a.html, /ref 3f2a91c0/);
  assert.match(j.html, /Regional Verifier \(NRV\) · South West/);
  assert.match(j.html, /Verifiers must report what the sheets show, whoever it helps\./);
  for (const m of [a, j]) { assert.doesNotMatch(m.html + m.subject, LOADED); assert.match(m.html, /contact\/\?topic=verifier/); }
});

test("request-for-information text: UK English, fixed, no loaded terms, asks for no documents", () => {
  assert.doesNotMatch(INFO_BODY + INFO_SUBJECT("3f2a91c0"), LOADED);
  assert.doesNotMatch(INFO_BODY, /\b(color|favor|organiz|recogniz|apologiz)/i);
  assert.match(INFO_BODY, /question 7/);
  assert.match(INFO_BODY, /do not send photos of result sheets, your voter card or any other documents/);
});

test("route refuses before any read: no session → 401 on GET and POST", async () => {
  const orig = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error("no network in tests"); };
  try {
    const req = (method) => new Request("https://binchika.com/api/admin/applications", { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify({ action: "approve", applicationId: ID }) : undefined });
    assert.equal((await route.onRequestGet({ request: req("GET"), env })).status, 401);
    assert.equal((await route.onRequestPost({ request: req("POST"), env })).status, 401);
    assert.equal(fetched, 0, "nothing fetched before the sign-in check");
    assert.equal((await route.onRequestGet({ request: req("GET"), env: {} })).status, 503, "unconfigured: refused");
  } finally { globalThis.fetch = orig; }
});
