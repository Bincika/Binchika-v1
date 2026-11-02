import { test } from "node:test";
import assert from "node:assert/strict";
import { autoReplyDecision, autoReplyMail, AUTO_REPLY_SENDER, AUTO_REPLY_DAILY_LIMIT } from "../functions/_lib/autoreply.js";
import { sendFromDashboard } from "../functions/_lib/mailsend.js";
import worker from "../workers/mailbox/src/index.js";

// Minimal D1 stand-in: records every statement; first() answers from a queue.
function fakeDB(firstAnswers = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { bind: (...args) => ({ sql, args, first: async () => (calls.push({ sql, args }), firstAnswers.shift() ?? null), run: async () => (calls.push({ sql, args }), { meta: { changes: 1 } }) }), first: async () => (calls.push({ sql, args: [] }), firstAnswers.shift() ?? null) };
    },
  };
}
const RAW = ["From: Ada <ada@example.org>", "To: ops@binchika.com", "Subject: Seat question", "Message-ID: <m-1@example.org>", "Content-Type: text/plain", "", "Hello Ops.", ""].join("\r\n");
// An incoming message as the Email Worker sees it; log records the order of forward, store and send.
function incoming(log, { from = "ada@example.org", to = "ops@binchika.com", headers = {}, forwardFails = false } = {}) {
  return {
    from, to, raw: new TextEncoder().encode(RAW),
    headers: new Headers({ subject: "Seat question", "message-id": "<m-1@example.org>", ...headers }),
    forward: async () => { if (forwardFails) throw new Error("forward failed"); log.push("forward"); },
    setReject: (why) => log.push(`reject: ${why}`),
  };
}
function env(log, DB, extra = {}) {
  return { EMAIL_FORWARD_TO: "owner@example.org", AUTO_REPLY: "on", RESEND_API_KEY: "k", DB, EVIDENCE: { put: async () => log.push("store") }, ...extra };
}
const quiet = (fn) => async () => { const l = console.log; console.log = () => {}; try { await fn(); } finally { console.log = l; } };

test("auto-reply: answers people, never robots, lists, bounces, failed authentication or our own domain", () => {
  const H = (o = {}) => new Headers(o);
  assert.deepEqual(autoReplyDecision({ from: "Ada@Example.org", headers: H() }), { reply: true, reason: "ok", to: "ada@example.org" });
  const cases = [
    [{ from: "" }, "no usable sender"],
    [{ from: "<>" }, "no usable sender"],
    [{ from: "a@b@c.org" }, "no usable sender"],
    [{ from: "ops@binchika.com" }, "own domain"],
    [{ from: "x@mail.binchika.com" }, "own domain"],
    [{ from: "noreply@bank.example" }, "automated sender"],
    [{ from: "no-reply@bank.example" }, "automated sender"],
    [{ from: "MAILER-DAEMON@mx.example" }, "automated sender"],
    [{ from: "postmaster@mx.example" }, "automated sender"],
    [{ from: "bounces+123@mx.example" }, "automated sender"],
    [{ from: "a@example.org", headers: H({ "auto-submitted": "auto-replied" }) }, "auto-submitted"],
    [{ from: "a@example.org", headers: H({ precedence: "bulk" }) }, "bulk or list"],
    [{ from: "a@example.org", headers: H({ "list-unsubscribe": "<https://x.example/u>" }) }, "mailing list"],
    [{ from: "a@example.org", headers: H({ "list-id": "<news.example>" }) }, "mailing list"],
    [{ from: "a@example.org", headers: H({ "x-auto-response-suppress": "OOF, AutoReply" }) }, "suppression requested"],
    [{ from: "a@example.org", headers: H({ "content-type": "multipart/report; report-type=delivery-status" }) }, "delivery report"],
    [{ from: "a@example.org", headers: H({ "arc-authentication-results": "i=1; mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom=example.org; dmarc=none" }) }, "failed authentication"],
    [{ from: "a@example.org", headers: H({ "authentication-results": "mx; dmarc=fail header.from=example.org" }) }, "failed authentication"],
    [{ from: "a@example.org", headers: H({ "x-spam-flag": "YES" }) }, "spam"],
  ];
  for (const [m, reason] of cases) assert.deepEqual(autoReplyDecision(m), { reply: false, reason }, JSON.stringify(m.from));
  assert.equal(autoReplyDecision({ from: "a@example.org", headers: H({ "auto-submitted": "no" }) }).reply, true, "Auto-Submitted: no is a person");
  assert.equal(autoReplyDecision({ from: "a@example.org", headers: H({ "arc-authentication-results": "spf=pass; dkim=pass; dmarc=pass" }) }).reply, true);
  assert.equal(autoReplyDecision({ from: "a@example.org" }).reply, true, "missing headers do not throw");
});

test("auto-reply: the message thanks them, comes from noreply@, Reply-To the address they wrote to, and quotes nothing", () => {
  const m = autoReplyMail({ mailbox: "accounts", subject: "Manifesto <b>request</b>\r\nBcc: x@evil.test", messageId: "<p-1@example.org>" });
  assert.equal(m.from, "Binchika <noreply@binchika.com>");
  assert.equal(m.replyTo, "accounts@binchika.com");
  assert.equal(m.subject, "Re: Manifesto <b>request</b> Bcc: x@evil.test", "no header injection");
  assert.match(m.text, /^Thank you for contacting Binchika\. This is an automatic reply to confirm that your message to accounts@binchika\.com has arrived\./);
  assert.match(m.text, /The Binchika team will get in touch soon\./);
  assert.match(m.html, /agogo-128\.png/);
  assert.match(m.html, /Manifesto &lt;b&gt;request/, "subject is escaped in the HTML");
  assert.match(m.html, /Only INEC declares election results/);
  assert.deepEqual(m.headers, { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All", "In-Reply-To": "<p-1@example.org>", References: "<p-1@example.org>" });
  const bare = autoReplyMail({ mailbox: "elsewhere", subject: "", messageId: "not an id" });
  assert.equal(bare.subject, "We have received your message");
  assert.equal(bare.replyTo, "noreply@binchika.com");
  assert.equal(bare.headers["In-Reply-To"], undefined);
});

test("worker: forwards, then stores, then sends one auto-reply recorded in Sent", quiet(async () => {
  const log = [], sent = [];
  globalThis.fetch = async (url, init) => (log.push("reply"), sent.push({ url, body: JSON.parse(init.body) }), new Response(JSON.stringify({ id: "re_auto" }), { status: 200 }));
  const DB = fakeDB([{ total: 0, same: 0 }]);
  await worker.email(incoming(log), env(log, DB));
  assert.deepEqual(log, ["forward", "store", "reply"], "forwarding and the Inbox copy come first");
  const b = sent[0].body;
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.equal(b.from, "Binchika <noreply@binchika.com>");
  assert.deepEqual(b.to, ["ada@example.org"]);
  assert.equal(b.reply_to, "ops@binchika.com");
  assert.equal(b.subject, "Re: Seat question");
  assert.equal(b.headers["Auto-Submitted"], "auto-replied");
  const check = DB.calls.find((c) => /SELECT COUNT/.test(c.sql));
  assert.deepEqual(check.args, ['["ada@example.org"]', AUTO_REPLY_SENDER]);
  const row = DB.calls.findLast((c) => /INSERT INTO mail_messages/.test(c.sql));
  assert.match(row.sql, /VALUES \(\?1, 'out', 'noreply'/);
  assert.equal(row.args[1], "noreply@binchika.com");
  assert.equal(row.args[3], '["ada@example.org"]');
  assert.equal(row.args[7], "<m-1@example.org>");
  assert.equal(row.args[8], "re_auto");
  assert.equal(row.args[9], AUTO_REPLY_SENDER);
}));

test("worker: no auto-reply when switched off, already sent today, over the daily cap, unconfigured or for a robot — delivery unchanged", quiet(async () => {
  let replies = 0;
  globalThis.fetch = async () => (replies++, new Response("{}", { status: 200 }));
  for (const [label, e, answers, msg] of [
    ["off", { AUTO_REPLY: "off" }, [], {}],
    ["no key", { RESEND_API_KEY: undefined }, [], {}],
    ["same sender today", {}, [{ total: 1, same: 1 }], {}],
    ["daily cap", {}, [{ total: AUTO_REPLY_DAILY_LIMIT, same: 0 }], {}],
    ["robot", {}, [{ total: 0, same: 0 }], { from: "noreply@shop.example" }],
    ["list", {}, [{ total: 0, same: 0 }], { headers: { "list-id": "<l.example>" } }],
  ]) {
    const log = [];
    await worker.email(incoming(log, msg), env(log, fakeDB(answers), e));
    assert.deepEqual(log, ["forward", "store"], label);
  }
  assert.equal(replies, 0);
}));

test("worker: a refused or failing reply never affects delivery; a rejected message gets no reply", quiet(async () => {
  const log = [];
  globalThis.fetch = async () => (log.push("reply"), new Response(JSON.stringify({ message: "quota" }), { status: 429 }));
  const DB = fakeDB([{ total: 0, same: 0 }]);
  await worker.email(incoming(log), env(log, DB));
  assert.deepEqual(log, ["forward", "store", "reply"]);
  assert.equal(DB.calls.filter((c) => /INSERT/.test(c.sql)).length, 1, "only the Inbox row; no Sent row for a refused reply");

  const log2 = [];
  globalThis.fetch = async () => { throw new Error("network down"); };
  await worker.email(incoming(log2), env(log2, fakeDB([{ total: 0, same: 0 }])));
  assert.deepEqual(log2, ["forward", "store"], "a thrown error is caught");

  const log3 = [];
  globalThis.fetch = async () => (log3.push("reply"), new Response("{}", { status: 200 }));
  await worker.email(incoming(log3, { forwardFails: true }), env(log3, fakeDB(), { EVIDENCE: { put: async () => { throw new Error("R2 down"); } } }));
  assert.equal(log3.length, 1);
  assert.match(log3[0], /^reject: /, "bounced, and no auto-reply");
}));

test("dashboard daily limit does not count automatic replies", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  const DB = fakeDB([{ n: 0 }]);
  await sendFromDashboard({ RESEND_API_KEY: "k", DB }, { from: "ops", to: "a@example.org", subject: "s", body: "b" }, "V0001");
  const count = DB.calls.find((c) => /SELECT COUNT/.test(c.sql));
  assert.match(count.sql, /COALESCE\(sent_by, ''\) NOT IN \(\?1, \?2\)/);
  assert.deepEqual(count.args, [AUTO_REPLY_SENDER, "unsubscribe"], "session 96: unsubscribe confirmations have their own cap too");
});
