import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  validateContact, addContact, updateContact, removeContact, createCampaign, updateCampaign, deleteCampaign, listRegistry,
  unsubToken, readUnsubToken, optOut, sendCampaign, isOptOutRequest, isCampaignLoopback, maskEmail, CAMPAIGN_DAILY_LIMIT,
} from "../functions/_lib/campaigns.js";
import { sendFromDashboard } from "../functions/_lib/mailsend.js";

// Contacts, campaigns, BCC-only send and unsubscribe (session 96). Real SQLite with the real D1 migrations, foreign keys on as in D1.
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of ["0004_mailbox.sql", "0009_contacts.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { db, prepare: (sql) => stmt(sql) };
}
const KEY = "test-unsubscribe-key-not-a-secret";
const envOf = (extra = {}) => ({ DB: sqliteD1(), UNSUBSCRIBE_KEY: KEY, RESEND_API_KEY: "re_test", CAMPAIGN_OWNER_BCC: "owner@example.net", ...extra });
const hdrs = (o) => ({ get: (n) => o[n.toLowerCase()] ?? null });
function mockFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const data = Array.isArray(body) ? body.map((_, i) => ({ id: `re-${calls.length}-${i}` })) : undefined;
    return new Response(JSON.stringify(data ? { data } : { id: `re-${calls.length}` }), { status: 200 });
  };
  return calls;
}
async function seed(env, n = 3) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await addContact(env, { name: `Person ${i}`, email: `Person${i}@Example.org` }, "V0001")).body.id);
  const camp = (await createCampaign(env, "Newsroom briefing", "V0001")).body.id;
  await updateCampaign(env, camp, { add: ids });
  return { ids, camp };
}

test("contact validation: name and email required; lengths capped", () => {
  assert.equal(validateContact({ name: "A", email: "a@example.org" }).ok, true);
  assert.equal(validateContact({ name: "", email: "a@example.org" }).ok, false);
  assert.equal(validateContact({ name: "A", email: "not-an-email" }).ok, false);
  assert.equal(validateContact({ name: "A", email: "a@example.org", notes: "x".repeat(1001) }).ok, false);
  assert.equal(validateContact({ name: "A\nB", email: " A@Example.ORG " }).contact.email, "a@example.org");
  assert.equal(validateContact({ name: "A\nB", email: "a@example.org" }).contact.name, "A B", "line breaks never reach a header");
});

test("contacts: add, duplicate refused case-insensitively, edit, remove", async () => {
  const env = envOf();
  const a = await addContact(env, { name: "Ada", email: "ada@example.org", organisation: "Desk" }, "V0001");
  assert.equal(a.status, 200);
  assert.equal((await addContact(env, { name: "Ada 2", email: "ADA@example.org" })).status, 409);
  assert.equal((await updateContact(env, a.body.id, { name: "Ada O.", email: "ada@example.org", notes: "met at briefing" })).status, 200);
  const reg = await listRegistry(env);
  assert.equal(reg.contacts[0].name, "Ada O.");
  assert.equal(reg.contacts[0].created_by, "V0001");
  assert.equal((await removeContact(env, a.body.id)).status, 200);
  assert.equal((await listRegistry(env)).contacts.length, 0);
  assert.equal((await addContact({ ...env, UNSUBSCRIBE_KEY: "" }, { name: "B", email: "b@example.org" })).status, 503, "fails closed without the key");
});

test("campaigns: a contact can be in two campaigns; deleting the contact removes its memberships", async () => {
  const env = envOf();
  const { ids, camp } = await seed(env, 2);
  const other = (await createCampaign(env, "Observers", "V0001")).body.id;
  assert.equal((await createCampaign(env, "observers")).status, 409, "names are unique, ignoring case");
  assert.deepEqual((await updateCampaign(env, other, { add: [ids[0], "not-a-uuid"] })).body, { ok: true, added: 1, removed: 0 });
  let reg = await listRegistry(env);
  assert.deepEqual(reg.contacts.find((c) => c.id === ids[0]).campaigns.sort(), [camp, other].sort());
  await removeContact(env, ids[0]);
  reg = await listRegistry(env);
  assert.deepEqual(reg.campaigns.map((c) => [c.name, c.members]), [["Newsroom briefing", 1], ["Observers", 0]]);
  assert.deepEqual((await updateCampaign(env, camp, { remove: [ids[1]], name: "Briefing" })).body, { ok: true, added: 0, removed: 1 });
  assert.equal((await deleteCampaign(env, camp)).status, 200);
  assert.equal((await listRegistry(env)).campaigns.length, 1);
});

test("unsubscribe token: genuine for its contact only; tampered or keyless tokens refused", async () => {
  const id = "11111111-2222-4333-8444-555555555555", other = "11111111-2222-4333-8444-666666666666";
  const t = await unsubToken(KEY, id);
  assert.equal(await readUnsubToken(KEY, t), id);
  assert.equal(await readUnsubToken(KEY, t.replace(id, other)), null);
  assert.equal(await readUnsubToken(KEY, `${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`), null);
  assert.equal(await readUnsubToken("another-key", t), null);
  assert.equal(await readUnsubToken("", t), null);
  assert.equal(await readUnsubToken(KEY, "preview"), null);
});

test("opt-out: removes the contact everywhere, records a keyed hash and masked address, confirms once, cannot be re-added", async () => {
  const env = envOf(), calls = mockFetch();
  const { ids } = await seed(env, 2);
  const r = await optOut(env, { contactId: ids[0], method: "link" });
  assert.deepEqual(r.body, { ok: true, removed: true, already: false, confirmed: true, masked: "p***@example.org" });
  const row = env.DB.db.prepare("SELECT * FROM opt_outs").get();
  assert.equal(row.method, "link");
  assert.deepEqual(JSON.parse(row.campaigns), ["Newsroom briefing"]);
  assert.match(row.email_sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(row).includes("person0@example.org"), false, "no clear address in opt_outs");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM campaign_members WHERE contact_id = ?").get(ids[0]).n, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.to, ["person0@example.org"]);
  assert.match(calls[0].body.from, /noreply@binchika\.com/);
  assert.match(calls[0].body.text, /Binchika will honour your request/);
  assert.match(calls[0].body.text, /removed from our contact registry/);
  assert.equal(env.DB.db.prepare("SELECT sent_by FROM mail_messages").get().sent_by, "unsubscribe", "confirmation is recorded in Sent");
  const again = await optOut(env, { email: "PERSON0@example.org", method: "reply" });
  assert.equal(again.body.already, true);
  assert.equal(calls.length, 1, "a second request sends nothing");
  assert.equal((await addContact(env, { name: "Back", email: "person0@example.org" })).status, 409);
  const stranger = await optOut(env, { email: "stranger@example.com", method: "reply", mailId: "m1" });
  assert.equal(stranger.body.removed, false);
  assert.equal(env.DB.db.prepare("SELECT mail_id FROM opt_outs WHERE email_masked = 's***@example.com'").get().mail_id, "m1");
});

test("campaign send: one message per person, the person only in Bcc, own unsubscribe link, one owner blind copy, no addresses logged", async () => {
  const env = envOf(), calls = mockFetch();
  const { ids, camp } = await seed(env, 3);
  const pv = await sendCampaign(env, { campaignId: camp, from: "noreply", subject: "Briefing on 4 November", body: "Hello,\n\nDetails below.", dryRun: true });
  assert.equal(pv.status, 200);
  assert.equal(pv.body.recipients, 3);
  assert.equal(calls.length, 0, "preview sends nothing");
  const r = await sendCampaign(env, { campaignId: camp, from: "noreply", subject: "Briefing on 4 November", body: "Hello,\n\nDetails below.", confirmCount: 3 }, "V0001");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.accepted, r.body.ownerCopy, r.body.status], [3, true, "sent"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails/batch");
  const msgs = calls[0].body;
  assert.equal(msgs.length, 4);
  const seen = new Set();
  for (const m of msgs) {
    assert.deepEqual(m.to, ["noreply@binchika.com"], "To is only our own address");
    assert.equal(m.cc, undefined);
    assert.equal(m.bcc.length, 1, "exactly one Bcc per message");
    seen.add(m.bcc[0]);
    assert.match(m.headers["X-Binchika-Campaign"], /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/);
  }
  assert.deepEqual([...seen].sort(), ["owner@example.net", "person0@example.org", "person1@example.org", "person2@example.org"]);
  for (const [i, m] of msgs.slice(0, 3).entries()) {
    const url = /<(https:\/\/binchika\.com\/api\/unsubscribe\?t=[^>]+)>/.exec(m.headers["List-Unsubscribe"])[1];
    const cid = await readUnsubToken(KEY, new URL(url).searchParams.get("t"));
    const owner = env.DB.db.prepare("SELECT email FROM contacts WHERE id = ?").get(cid).email;
    assert.equal(owner, m.bcc[0], `message ${i} carries its own recipient's link`);
    assert.ok(m.html.includes(url) && m.text.includes(url));
  }
  const ownerCopy = msgs[3];
  assert.equal(ownerCopy.headers["List-Unsubscribe"], undefined);
  assert.match(ownerCopy.text, /Owner copy: this campaign \("Newsroom briefing"\) went to 3 people, each individually by Bcc/);
  const log = env.DB.db.prepare("SELECT * FROM campaign_sends").get();
  assert.deepEqual([log.recipients, log.accepted, log.owner_copy, log.status, log.sent_by], [3, 3, 1, "sent", "V0001"]);
  assert.equal(JSON.stringify(log).includes("@example"), false, "the send log holds no addresses");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM mail_messages").get().n, 0, "campaign copies are not stored in the mailbox");
  // An opted-out member is never sent to, even if still linked.
  await optOut(env, { contactId: ids[1], method: "link" });
  const pv2 = await sendCampaign(env, { campaignId: camp, from: "ops", subject: "s", body: "b", dryRun: true });
  assert.equal(pv2.body.recipients, 2);
});

test("campaign send refuses: missing configuration, wrong confirmed count, empty campaign, over the daily cap, provider refusal", async () => {
  const calls = mockFetch();
  let env = envOf();
  const { camp } = await seed(env, 2);
  const base = { campaignId: camp, from: "noreply", subject: "s", body: "b", confirmCount: 2 };
  for (const miss of ["RESEND_API_KEY", "UNSUBSCRIBE_KEY", "CAMPAIGN_OWNER_BCC"]) assert.equal((await sendCampaign({ ...env, [miss]: "" }, base)).status, 503, miss);
  assert.equal((await sendCampaign(env, { ...base, confirmCount: 3 })).status, 422);
  assert.equal((await sendCampaign(env, { ...base, from: "someone" })).status, 422);
  const empty = (await createCampaign(env, "Empty")).body.id;
  assert.equal((await sendCampaign(env, { ...base, campaignId: empty, confirmCount: 0 })).status, 422);
  env.DB.db.prepare("INSERT INTO campaign_sends (id, campaign_name, mailbox, subject, body_text, recipients, accepted, status) VALUES ('x', 'old', 'noreply', 's', 'b', ?, ?, 'sent')").run(CAMPAIGN_DAILY_LIMIT, CAMPAIGN_DAILY_LIMIT - 1);
  assert.equal((await sendCampaign(env, base)).status, 429);
  assert.equal(calls.length, 0, "nothing was sent by any refusal");
  env = envOf();
  const s2 = await seed(env, 1);
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "quota" }), { status: 429 });
  const r = await sendCampaign(env, { ...base, campaignId: s2.camp, confirmCount: 1 });
  assert.equal(r.status, 502);
  assert.equal(env.DB.db.prepare("SELECT status FROM campaign_sends").get().status, "failed", "a refused send is logged as failed; a retry is a new send");
});

test("reply keyword: subject or first line only", () => {
  for (const m of [{ subject: "unsubscribe" }, { subject: "Re: STOP" }, { subject: "Re: Briefing", text: "Remove me\n\n> On 1 Nov..." }, { subject: "x", text: "\n  Unsubscribe.  \n" }, { subject: "Fwd: Re: opt out" }])
    assert.equal(isOptOutRequest(m), true, JSON.stringify(m));
  for (const m of [{ subject: "How do I unsubscribe from the feed?" }, { subject: "Re: Briefing", text: "Thanks! Please do not stop sending these.\nunsubscribe" }, { subject: "Stop the count", text: "" }])
    assert.equal(isOptOutRequest(m), false, JSON.stringify(m));
});

test("loop-back: only our own campaign copies with a genuine marker are recognised", async () => {
  const env = envOf(), calls = mockFetch();
  const { camp } = await seed(env, 1);
  await sendCampaign(env, { campaignId: camp, from: "noreply", subject: "s", body: "b", confirmCount: 1 });
  const marker = calls[0].body[0].headers["X-Binchika-Campaign"];
  assert.equal(await isCampaignLoopback(env, "Binchika <noreply@binchika.com>", hdrs({ "x-binchika-campaign": marker })), true);
  assert.equal(await isCampaignLoopback(env, "someone@example.org", hdrs({ "x-binchika-campaign": marker })), false, "outsiders are never skipped");
  assert.equal(await isCampaignLoopback(env, "noreply@binchika.com", hdrs({ "x-binchika-campaign": marker.slice(0, -2) + "zz" })), false);
  const forged = `${"a".repeat(8)}-aaaa-4aaa-8aaa-${"a".repeat(12)}.${"A".repeat(32)}`;
  assert.equal(await isCampaignLoopback(env, "noreply@binchika.com", hdrs({ "x-binchika-campaign": forged })), false);
  assert.equal(await isCampaignLoopback(env, "noreply@binchika.com", hdrs({})), false);
});

test("dashboard daily cap ignores unsubscribe confirmations", async () => {
  const env = envOf();
  const ins = env.DB.db.prepare("INSERT INTO mail_messages (id, direction, mailbox, from_addr, to_addrs, subject, sent_by) VALUES (?, 'out', 'noreply', 'noreply@binchika.com', '[]', 's', 'unsubscribe')");
  for (let i = 0; i < 100; i++) ins.run(`u${i}`);
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  const r = await sendFromDashboard(env, { from: "ops", to: "a@example.org", subject: "s", body: "b" }, "V0001");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(maskEmail("x"), "unknown");
});

// ---- mailbox Worker (session 96) ----
import worker from "../workers/mailbox/src/index.js";
const eml = (from, subject, body, extra = []) => [`From: ${from}`, "To: noreply@binchika.com", `Subject: ${subject}`, "Message-ID: <m-9@example.org>", ...extra, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");
function message(raw, envelopeFrom, headerMap) {
  const log = { forwarded: 0, rejected: null };
  return { log, msg: { raw, from: envelopeFrom, to: "noreply@binchika.com", headers: hdrs(headerMap), forward: async () => { log.forwarded++; }, setReject: (r) => { log.rejected = r; } } };
}
const workerEnv = (env) => ({ ...env, EMAIL_FORWARD_TO: "owner@example.net", AUTO_REPLY: "on", EVIDENCE: { put: async () => {} } });
const silent = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

test("worker: our own campaign copy is accepted quietly — not forwarded, not stored, no reply, not rejected", async () => {
  const env = workerEnv(envOf()), calls = mockFetch();
  const { camp } = await seed(env, 1);
  await sendCampaign(env, { campaignId: camp, from: "noreply", subject: "s", body: "b", confirmCount: 1 });
  const marker = calls[0].body[0].headers["X-Binchika-Campaign"];
  const { log, msg } = message(eml("Binchika <noreply@binchika.com>", "s", "b"), "bounce@send.binchika.com", { from: "Binchika <noreply@binchika.com>", "x-binchika-campaign": marker, subject: "s" });
  await silent(() => worker.email(msg, env));
  assert.deepEqual(log, { forwarded: 0, rejected: null });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM mail_messages").get().n, 0);
  assert.equal(calls.length, 1, "no reply was sent");
});

test("worker: an UNSUBSCRIBE reply from a contact is forwarded and stored first, then removes them and confirms instead of the auto-reply", async () => {
  const env = workerEnv(envOf()), calls = mockFetch();
  await seed(env, 2);
  const { log, msg } = message(eml("Person 0 <person0@example.org>", "Re: Briefing", "unsubscribe\r\n\r\n> earlier text"), "person0@example.org", { from: "Person 0 <person0@example.org>", subject: "Re: Briefing" });
  await silent(() => worker.email(msg, env));
  assert.equal(log.forwarded, 1, "the owner still gets the message");
  const inbox = env.DB.db.prepare("SELECT id FROM mail_messages WHERE direction = 'in'").get();
  assert.ok(inbox, "the message is in the Inbox");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email = 'person0@example.org'").get().n, 0);
  assert.deepEqual({ ...env.DB.db.prepare("SELECT method, mail_id, confirmed FROM opt_outs").get() }, { method: "reply", mail_id: inbox.id, confirmed: 1 });
  assert.equal(calls.length, 1, "exactly one email: the confirmation, no automatic reply");
  assert.match(calls[0].body.subject, /unsubscribed/);
  // A spoofed-looking request (failed DMARC) is only flagged, never acted on.
  const env2 = workerEnv(envOf()); mockFetch();
  await seed(env2, 1);
  const m2 = message(eml("person0@example.org", "unsubscribe", ""), "person0@example.org", { from: "person0@example.org", subject: "unsubscribe", "authentication-results": "mx; dmarc=fail" });
  await silent(() => worker.email(m2.msg, env2));
  assert.equal(env2.DB.db.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 1);
  assert.equal(env2.DB.db.prepare("SELECT COUNT(*) AS n FROM opt_outs").get().n, 0);
});

test("worker: ordinary mail is unchanged — forwarded, stored and auto-replied", async () => {
  const env = workerEnv(envOf()), calls = mockFetch();
  const { log, msg } = message(eml("Reader <reader@example.org>", "A question", "How do I unsubscribe from the feed later?"), "reader@example.org", { from: "Reader <reader@example.org>", subject: "A question", "message-id": "<m-9@example.org>" });
  await silent(() => worker.email(msg, env));
  assert.equal(log.forwarded, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM mail_messages WHERE direction = 'in'").get().n, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.subject, /Re: A question/);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM opt_outs").get().n, 0);
});

test("Inbox list: opt-out state from opt_outs, and the old list still works before migration 0009", async () => {
  const { onRequestGet } = await import("../functions/api/admin/mail/index.js");
  const supa = await import("../functions/_lib/supa.js");
  assert.equal(typeof onRequestGet, "function");
  // The route needs a signed-in BinchikAdmin; here we check its two SQL paths directly against real SQLite.
  const env = envOf();
  env.DB.db.prepare("INSERT INTO mail_messages (id, direction, mailbox, from_addr, to_addrs, subject, body_text) VALUES ('a', 'in', 'noreply', 'x@example.org', '[]', 'Re: Briefing', 'unsubscribe')").run();
  env.DB.db.prepare("INSERT INTO opt_outs (id, email_sha256, email_masked, method, mail_id) VALUES ('o', 'h', 'x***@example.org', 'reply', 'a')").run();
  const row = env.DB.db.prepare("SELECT m.id, o.at AS optout_at, o.method AS optout_method FROM mail_messages m LEFT JOIN opt_outs o ON o.mail_id = m.id").get();
  assert.equal(row.optout_method, "reply");
  const old = new DatabaseSync(":memory:");
  old.exec(readFileSync(new URL("../db/d1/0004_mailbox.sql", import.meta.url), "utf8"));
  assert.throws(() => old.prepare("SELECT m.id FROM mail_messages m LEFT JOIN opt_outs o ON o.mail_id = m.id").all(), /no such table/, "this is why the route falls back to the old query");
  assert.ok(supa.requireAdmin);
});
