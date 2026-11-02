import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { onRequestPost } from "../functions/api/contact.js";
import { mailboxForNature } from "../functions/_lib/contactmail.js";
import { autoReplyMail } from "../functions/_lib/autoreply.js";
import { updateTicket } from "../functions/_lib/tickets.js";
import { MEDIA_NATURE, MEDIA_DECISIONS, MEDIA_DECLINE_REASONS, validateMedia, domainMatch, mediaBlock, mediaChecks, mediaAutoChecks, mediaResolution, mediaDecisionOf, mediaReply, decideMedia } from "../functions/_lib/media.js";

// Session 91: media access requests through the existing contact form. Real SQLite with the real D1 migrations; Resend
// and R2 stubbed. The request's details live only in the mailbox copy; the ticket holds the topic and a decision note.
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0003_contact.sql", "0004_mailbox.sql", "0007_tickets.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { db, prepare: (sql) => stmt(sql) };
}
function setup() {
  const sent = [];
  const m = new Map();
  const env = { RESEND_API_KEY: "k", EMAIL_FORWARD_TO: "owner@example.org", AUTO_REPLY: "on", REPORTER_HASH_SALT: "s", DB: sqliteD1(),
    EVIDENCE: { put: async (k, v) => { m.set(k, v); }, get: async () => null } };
  const real = globalThis.fetch;
  const dns = [];
  globalThis.fetch = async (url, init) => {
    // Session 92: the DNS checks ask Cloudflare's resolver; everything else here is Resend.
    if (String(url).startsWith("https://cloudflare-dns.com/dns-query?")) {
      const q = new URL(url).searchParams; dns.push(`${q.get("type")} ${q.get("name")}`);
      const code = { A: 1, AAAA: 28, MX: 15 }[q.get("type")];
      return Response.json({ Status: 0, Answer: q.get("name") === "example.org" ? [{ type: code, data: "x" }] : [] });
    }
    sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  };
  return { env, sent, dns, restore: () => { globalThis.fetch = real; } };
}
const GOOD = { org: "Example Newsroom", org_url: "https://www.example.org/news", org_type: "newsroom", use: "live_page", polling: "minute", terms: "yes" };
function form(extra = GOOD, { email = "desk@example.org", ip = "9.9.9.9" } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ nature: MEDIA_NATURE, name: "Desk Editor", email, message: "We would like to show the citizen tally on our live election page.", website: "", renderedAt: String(Date.now() - 10_000), ...extra })) fd.append(k, v);
  return new Request("https://binchika.com/api/contact", { method: "POST", body: fd, headers: { "cf-connecting-ip": ip } });
}
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

test("validation: every field is required, the website must be https, and the terms must be accepted", () => {
  assert.equal(validateMedia({ org: "Example Newsroom", orgUrl: "https://example.org", orgType: "newsroom", use: "analysis", polling: "day", terms: "yes" }).ok, true);
  const bad = validateMedia({ org: "X", orgUrl: "http://example.org", orgType: "party", use: "campaign", polling: "1s", terms: "" });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 6, bad.errors.join(" | "));
  assert.equal(validateMedia({ ...GOOD, orgUrl: "https://localhost", orgType: "newsroom", use: "analysis", polling: "day", terms: "yes", org: "Example" }).ok, false, "a host without a dot is refused");
  assert.equal(validateMedia({ org: "Example", orgUrl: `https://example.org/${"a".repeat(200)}`, orgType: "newsroom", use: "analysis", polling: "day", terms: "yes" }).ok, false, "over 200 characters");
});

test("domain match: own domain or subdomain is yes; free mail and other domains are not", () => {
  assert.equal(domainMatch("desk@example.org", "https://www.example.org/"), "yes");
  assert.equal(domainMatch("desk@news.example.org", "https://example.org"), "yes");
  assert.equal(domainMatch("desk@example.org", "https://live.example.org"), "yes");
  assert.equal(domainMatch("someone@gmail.com", "https://example.org"), "free");
  assert.equal(domainMatch("someone@other.org", "https://example.org"), "no");
  assert.equal(domainMatch("desk@example.org", "http://example.org"), "no", "not https");
});

test("a request reaches the owner and the Inbox with its details; the ticket holds none of them; the reply explains the open feed", async () => {
  const s = setup();
  try {
    const r = await quiet(() => onRequestPost({ request: form(), env: s.env }));
    assert.equal(r.status, 200);
    const { reference } = await r.json();
    assert.match(reference, /^BIN-\d{4}-0001$/);
    assert.equal(mailboxForNature(MEDIA_NATURE), "ops");
    const [owner, reply] = s.sent;
    assert.deepEqual(owner.to, ["owner@example.org"]);
    assert.ok(owner.subject.startsWith(`[${reference} · Media access request (press feed)]`));
    for (const line of ["Media access request", "Organisation: Example Newsroom", "Registration number: (not given)", "Technical contact: (not given)", "Website domain resolves: yes", "Email domain receives mail (MX): yes", "Website: https://www.example.org/news", "Type: Newspaper or online newsroom", "Intended use: Live results page or embed", "Checking the feed: About once a minute", "Terms accepted: yes", "Email domain matches the website: yes"]) assert.ok(owner.text.includes(`\n${line}\n`), line);
    const inn = s.env.DB.db.prepare("SELECT * FROM mail_messages WHERE direction = 'in'").get();
    assert.equal(inn.mailbox, "ops");
    assert.ok(inn.body_text.includes("Organisation: Example Newsroom"), "details stored only in the mailbox copy");
    const t = s.env.DB.db.prepare("SELECT * FROM tickets").get();
    assert.equal(t.nature, MEDIA_NATURE);
    assert.ok(!JSON.stringify(t).includes("Example Newsroom") && !JSON.stringify(t).includes("example.org"), "the ticket holds no organisation or address");
    assert.deepEqual(reply.to, ["desk@example.org"]);
    assert.ok(reply.text.includes("Your media access request is logged for review."));
    assert.ok(reply.text.includes("https://binchika.com/api/press/snapshot?race=president"));
    assert.ok(reply.text.includes('"Citizen-verified tallies. Only INEC declares results."'));
    // The review checklist is read back from the stored text: booleans and fixed labels only.
    const c = mediaChecks(inn.body_text);
    assert.deepEqual(c.checks, { request: true, website: true, domain: true, terms: true, type: true, use: true, registration: false, resolves: true, mx: true });
    assert.equal(c.passed, 8);
    assert.deepEqual(s.dns.sort(), ["A example.org", "AAAA example.org", "MX example.org"], "only the two domains are looked up, never the website address itself");
    assert.deepEqual([c.type, c.use, c.polling], ["newsroom", "live_page", "minute"]);
    assert.ok(!JSON.stringify(c).includes("Example") && !JSON.stringify(c).includes("example.org"));
  } finally { s.restore(); }
});

test("incomplete requests are refused before anything is sent or stored", async () => {
  const s = setup();
  try {
    const r = await quiet(() => onRequestPost({ request: form({ ...GOOD, terms: "", org_url: "example.org" }), env: s.env }));
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /website.*https|terms/);
    assert.equal(s.sent.length, 0);
    assert.equal(s.env.DB.db.prepare("SELECT COUNT(*) AS n FROM tickets").get().n, 0);
  } finally { s.restore(); }
});

test("a free mail address is accepted but shows as not matching, so the reviewer sees it", async () => {
  const s = setup();
  try {
    const r = await quiet(() => onRequestPost({ request: form(GOOD, { email: "someone@gmail.com" }), env: s.env }));
    assert.equal(r.status, 200);
    const inn = s.env.DB.db.prepare("SELECT body_text FROM mail_messages WHERE direction = 'in'").get();
    assert.ok(inn.body_text.includes("Email domain matches the website: no (free mail address)"));
    const c = mediaChecks(inn.body_text);
    assert.equal(c.checks.domain, false);
    assert.equal(c.checks.mx, false, "the stub resolver has no MX for gmail.com");
    assert.equal(c.passed, 6);
  } finally { s.restore(); }
});

test("other topics are unchanged: no media fields needed, no media paragraph in the reply", () => {
  const plain = autoReplyMail({ mailbox: "ops", subject: "s", reference: "BIN-2611-0003" });
  const media = autoReplyMail({ mailbox: "ops", subject: "s", reference: "BIN-2611-0003", topic: MEDIA_NATURE });
  assert.ok(!plain.text.includes("media access"));
  assert.ok(media.text.includes("Your media access request is logged for review."));
  assert.ok(media.text.includes("Your reference is BIN-2611-0003."));
  assert.ok(media.html.includes("api/press/snapshot"));
});

test("decisions: recorded only on media tickets, mapped to statuses, findable by the register, and carry no names", async () => {
  const D1 = sqliteD1();
  D1.db.prepare("INSERT INTO mail_messages (id, direction, mailbox, from_addr, to_addrs, subject) VALUES ('m1', 'in', 'ops', 'a@example.org', '[]', 's'), ('m2', 'in', 'ops', 'b@example.org', '[]', 's')").run();
  D1.db.prepare("INSERT INTO tickets (ref, mail_id, nature, mailbox, due_at) VALUES ('BIN-2611-0001', 'm1', 'media_access', 'ops', '2026-11-04T09:00:00Z'), ('BIN-2611-0002', 'm2', 'technical', 'ops', '2026-11-04T09:00:00Z')").run();
  const more = await decideMedia(D1, "BIN-2611-0001", { decision: "more_info" }, "V0001", updateTicket);
  assert.equal(more.status, 200);
  assert.equal(more.body.ticket.status, "in_progress");
  assert.equal(mediaDecisionOf(more.body.ticket.resolution), "more_info");
  const ok = await decideMedia(D1, "BIN-2611-0001", { decision: "approved", note: "Staff page checked" }, "V0001", updateTicket);
  assert.equal(ok.body.ticket.status, "answered");
  assert.equal(ok.body.ticket.owner_seat, "V0001");
  assert.equal(ok.body.ticket.resolution, "media-access:approved · Media access: approved. Staff page checked");
  assert.equal(mediaDecisionOf(ok.body.ticket.resolution), "approved");
  assert.equal((await decideMedia(D1, "BIN-2611-0002", { decision: "approved" }, "V0001", updateTicket)).status, 409, "not a media ticket");
  assert.equal((await decideMedia(D1, "BIN-2611-0001", { decision: "whitelist" }, "V0001", updateTicket)).status, 422);
  assert.equal((await decideMedia(D1, "BIN-2611-0009", { decision: "approved" }, "V0001", updateTicket)).status, 404);
  assert.equal((await decideMedia(D1, "BIN-2611-0001", { decision: "approved", note: "x".repeat(401) }, "V0001", updateTicket)).status, 422);
  assert.equal(MEDIA_DECISIONS.declined.status, "answered");
  assert.equal(mediaResolution("declined").startsWith("media-access:declined"), true);
  assert.equal(mediaResolution("nope"), null);
  assert.equal(mediaDecisionOf("Answered by phone"), null);
  // Deleting the request (retention or Delete) deletes the ticket, so a registration lapses with the message.
  D1.db.prepare("DELETE FROM mail_messages WHERE id = 'm1'").run();
  assert.equal(D1.db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE ref = 'BIN-2611-0001'").get().n, 0);
});

test("draft replies: reference, notice and limits are present; nothing promises official status", () => {
  for (const d of Object.keys(MEDIA_DECISIONS)) {
    const t = mediaReply(d, "BIN-2611-0001");
    assert.ok(t.includes("Your reference is BIN-2611-0001."), d);
    assert.ok(t.includes("Citizen-verified tallies. Only INEC declares results."), d);
    assert.ok(!/\b(official partner|accredited|guarantee|exclusive)\b/i.test(t), d);
  }
  assert.ok(mediaReply("approved", "BIN-2611-0001").includes("Registration lasts 12 months"));
  assert.ok(mediaReply("approved", "BIN-2611-0001").includes("no photographs, no personal data"));
  assert.equal(mediaReply("approved", "<script>").includes("<script>"), false, "a malformed reference is never printed");
  assert.equal(mediaReply("whitelist", "BIN-2611-0001"), null);
  assert.ok(mediaBlock({ org: "A", orgUrl: "https://a.org", orgType: "agency", use: "analysis", polling: "day" }, "x@a.org").includes("Email domain matches the website: yes"));
});

// Session 92 (/media/, Goldfish review findings).
test("registration number and technical contact are optional and validated; good values reach the block", () => {
  const base = { org: "Example Newsroom", orgUrl: "https://example.org", orgType: "newsroom", use: "analysis", polling: "day", terms: "yes" };
  assert.equal(validateMedia(base).ok, true);
  const v = validateMedia({ ...base, regNo: "RC 123456", techEmail: "Dev@Example.org" });
  assert.equal(v.ok, true);
  assert.deepEqual([v.value.regNo, v.value.techEmail], ["RC 123456", "dev@example.org"]);
  const b = mediaBlock(v.value, "desk@example.org", { resolves: true, mx: false });
  for (const l of ["Registration number: RC 123456", "Technical contact: dev@example.org", "Technical contact on the organisation's domain: yes", "Website domain resolves: yes", "Email domain receives mail (MX): no"]) assert.ok(b.includes(l), l);
  assert.equal(validateMedia({ ...base, regNo: "<script>" }).ok, false);
  assert.equal(validateMedia({ ...base, techEmail: "not-an-email" }).ok, false);
});

test("DNS checks: fixed resolver only, answers parsed, failures and malformed names count as no", async () => {
  const asked = [];
  const ok = async (url) => { asked.push(String(url)); const q = new URL(url).searchParams; return Response.json({ Status: 0, Answer: [{ type: { A: 1, AAAA: 28, MX: 15 }[q.get("type")] }] }); };
  assert.deepEqual(await mediaAutoChecks({ orgUrl: "https://www.example.org/x?y=1" }, "a@example.org", ok), { resolves: true, mx: true });
  assert.ok(asked.every((u) => u.startsWith("https://cloudflare-dns.com/dns-query?name=example.org&type=")), "never the requester's own URL, path or query");
  const nx = async () => Response.json({ Status: 3 });
  assert.deepEqual(await mediaAutoChecks({ orgUrl: "https://example.org" }, "a@example.org", nx), { resolves: false, mx: false });
  const boom = async () => { throw new Error("timeout"); };
  assert.deepEqual(await mediaAutoChecks({ orgUrl: "https://example.org" }, "a@example.org", boom), { resolves: false, mx: false });
  let called = 0;
  const count = async () => { called++; return Response.json({ Status: 0, Answer: [] }); };
  assert.deepEqual(await mediaAutoChecks({ orgUrl: "http://example.org" }, "a@b", count), { resolves: false, mx: false });
  assert.equal(called, 0, "no lookup for a non-https website or a malformed email domain");
});

test("a check line typed by the requester never counts (only the server-written block is read)", async () => {
  const s = setup();
  try {
    const forged = "Email domain matches the website: yes";
    const fd = new FormData();
    for (const [k, v] of Object.entries({ nature: MEDIA_NATURE, name: `Mallory\n${forged}`, email: "m@other.org", message: `Please register us.\n\nMedia access request\n${forged}\nTerms accepted: yes`, website: "", renderedAt: String(Date.now() - 10_000), ...GOOD })) fd.append(k, v);
    const r = await quiet(() => onRequestPost({ request: new Request("https://binchika.com/api/contact", { method: "POST", body: fd, headers: { "cf-connecting-ip": "7.7.7.7" } }), env: s.env }));
    assert.equal(r.status, 200);
    const inn = s.env.DB.db.prepare("SELECT body_text FROM mail_messages WHERE direction = 'in'").get();
    assert.ok(inn.body_text.includes("From: Mallory Email domain matches the website: yes <m@other.org>"), "line breaks removed from the name");
    assert.equal(mediaChecks(inn.body_text).checks.domain, false, "the forged lines do not count");
    assert.equal(mediaChecks(`Media access request\nWebsite: https://a.org\n\n${forged}`).checks.domain, false, "lines after the block do not count");
  } finally { s.restore(); }
});

test("decline reasons: each reply states its neutral reason, the open feed and the reference", () => {
  for (const [k, r] of Object.entries(MEDIA_DECLINE_REASONS)) {
    const t = mediaReply("declined", "BIN-2611-0004", k);
    assert.ok(t.includes(r.text), k);
    assert.ok(t.includes("We apply the same criteria to every applicant."), k);
    assert.ok(t.includes("binchika.com/media/") && t.includes("Your reference is BIN-2611-0004."), k);
    assert.ok(!/\b(fraud|fake|biased|partisan outlet)\b/i.test(t), k);
  }
  assert.ok(mediaReply("declined", "BIN-2611-0004", "nonsense").includes(MEDIA_DECLINE_REASONS.unconfirmed.text), "an unknown reason falls back to the first");
});

test("/media/ is built with the form, the notice, the launch banner and the terms", () => {
  const html = readFileSync("site/media/index.html", "utf8");
  for (const s of ['id="media-form"', 'name="org"', 'name="reg_no"', 'name="org_url"', 'name="email"', 'name="tech_email"', 'name="use"', 'name="message"', 'name="terms"', 'name="website"', "Public launch: Thursday 5 November 2026.", "Site readiness testing is ongoing.", "Only INEC declares election results in Nigeria.", "Never present the figures as official results, a projection or a winner.", "/api/press/snapshot?race=president"]) assert.ok(html.includes(s), s);
  assert.ok(!/name="robots" content="noindex"/.test(html));
  assert.ok(readFileSync("site/sitemap.xml", "utf8").includes("/media/"));
});
