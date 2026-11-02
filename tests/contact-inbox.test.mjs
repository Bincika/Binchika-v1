import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import PostalMime from "postal-mime";
import { onRequestPost } from "../functions/api/contact.js";
import { contactEml, mailboxForNature } from "../functions/_lib/contactmail.js";

// Session 77: every contact-form enquiry still goes to EMAIL_FORWARD_TO first, and is now also stored in the dashboard
// Inbox and answered with the branded automatic reply. Real SQLite with the real D1 migrations; R2 and Resend stubbed.
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
function fakeR2() {
  const m = new Map();
  return { m, put: async (k, v) => { m.set(k, new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer ?? v)); }, get: async (k) => (m.has(k) ? { arrayBuffer: async () => m.get(k).buffer } : null) };
}
function setup({ resendFails = false } = {}) {
  const sent = [];
  const env = { RESEND_API_KEY: "k", EMAIL_FORWARD_TO: "owner@example.org", AUTO_REPLY: "on", REPORTER_HASH_SALT: "s", DB: sqliteD1(), EVIDENCE: fakeR2() };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    const body = JSON.parse(init.body);
    sent.push(body);
    if (resendFails && body.to[0] === "owner@example.org") return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  };
  return { env, sent, restore: () => { globalThis.fetch = real; } };
}
function form({ nature = "data", name = "Ada Obi", email = "ada@example.org", message = "Please send the data behind the Lagos register figures.", files = [], ip = "1.2.3.4" } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ nature, name, email, message, website: "", renderedAt: String(Date.now() - 10_000) })) fd.append(k, v);
  for (const f of files) fd.append("files", f);
  return new Request("https://binchika.com/api/contact", { method: "POST", body: fd, headers: { "cf-connecting-ip": ip } });
}
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const rows = (env, dir) => env.DB.db.prepare("SELECT * FROM mail_messages WHERE direction = ? ORDER BY at").all(dir);

test("an enquiry reaches the owner first, then the Inbox, then the sender gets the branded reply", async () => {
  const s = setup();
  try {
    const pdf = new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])], "evidence.pdf", { type: "application/pdf" });
    const r = await quiet(() => onRequestPost({ request: form({ files: [pdf] }), env: s.env }));
    assert.equal(r.status, 200);
    assert.equal(s.sent.length, 2);
    assert.deepEqual(s.sent[0].to, ["owner@example.org"], "the owner's copy is sent first, unchanged");
    assert.equal(s.sent[0].reply_to, "ada@example.org");
    assert.equal(s.sent[0].attachments.length, 1);
    assert.deepEqual(s.sent[1].to, ["ada@example.org"], "then the automatic reply to the sender");
    assert.match(s.sent[1].from, /noreply@binchika\.com/);
    assert.equal(s.sent[1].reply_to, "accounts@binchika.com", "replies go to the mailbox for that kind of enquiry");
    assert.equal(s.sent[1].headers["Auto-Submitted"], "auto-replied");

    const [inn] = rows(s.env, "in");
    assert.equal(inn.mailbox, "accounts");
    assert.equal(inn.from_addr, "ada@example.org");
    assert.equal(inn.from_name, "Ada Obi");
    assert.match(inn.subject, /^\[BIN-\d{4}-0001 · Data request\]/, "the subject carries the ticket reference");
    const ref = inn.subject.match(/BIN-\d{4}-\d{4}/)[0];
    assert.equal((await r.json()).reference, ref, "the sender sees the same reference on the page");
    assert.ok(s.sent[0].subject.startsWith(`[${ref} · `), "the owner copy carries it too");
    assert.ok(s.sent[0].text.startsWith(`Reference: ${ref}\n`));
    assert.ok(s.sent[1].text.includes(`Your reference is ${ref}.`), "and the automatic reply");
    const t = s.env.DB.db.prepare("SELECT * FROM tickets").get();
    assert.equal(t.ref, ref);
    assert.equal(t.mail_id, inn.id);
    assert.equal(t.status, "new");
    assert.equal(t.mailbox, "accounts");
    assert.match(inn.body_text, /Lagos register figures/);
    assert.deepEqual(JSON.parse(inn.attachments).map((a) => [a.filename, a.size]), [["evidence.pdf", 8]]);
    const raw = s.env.EVIDENCE.m.get(inn.raw_key);
    const parsed = await PostalMime.parse(raw);
    assert.deepEqual([...new Uint8Array(parsed.attachments[0].content)], [37, 80, 68, 70, 45, 49, 46, 55], "the attachment can be downloaded from the Inbox");
    const [out] = rows(s.env, "out");
    assert.equal(out.sent_by, "auto-reply");
    assert.deepEqual(JSON.parse(out.to_addrs), ["ada@example.org"]);
  } finally { s.restore(); }
});

test("each nature lands in its own mailbox", () => {
  assert.equal(mailboxForNature("data"), "accounts");
  assert.equal(mailboxForNature("manifesto"), "accounts");
  assert.equal(mailboxForNature("error"), "ops");
  assert.equal(mailboxForNature("verifier"), "ops");
  assert.equal(mailboxForNature("press"), "noreply");
  assert.equal(mailboxForNature("unknown"), "noreply");
});

test("a second enquiry the same day is stored but not answered twice", async () => {
  const s = setup();
  try {
    await quiet(() => onRequestPost({ request: form(), env: s.env }));
    await quiet(() => onRequestPost({ request: form({ nature: "technical", message: "The map does not load on my phone today, sorry." }), env: s.env }));
    assert.equal(rows(s.env, "in").length, 2);
    assert.deepEqual(rows(s.env, "in").map((x) => x.mailbox).sort(), ["accounts", "ops"]);
    assert.equal(rows(s.env, "out").length, 1);
    assert.equal(s.sent.filter((m) => m.to[0] === "ada@example.org").length, 1);
  } finally { s.restore(); }
});

test("if the owner's copy cannot be sent, nothing is stored and no reply goes out", async () => {
  const s = setup({ resendFails: true });
  try {
    const r = await quiet(() => onRequestPost({ request: form(), env: s.env }));
    assert.equal(r.status, 502);
    assert.equal(rows(s.env, "in").length, 0);
    assert.equal(s.sent.length, 1);
  } finally { s.restore(); }
});

test("our own domain is stored but never auto-answered (no loops)", async () => {
  const s = setup();
  try {
    const r = await quiet(() => onRequestPost({ request: form({ email: "ops@binchika.com" }), env: s.env }));
    assert.equal(r.status, 200);
    assert.equal(rows(s.env, "in").length, 1);
    assert.equal(rows(s.env, "out").length, 0);
    assert.equal(s.sent.length, 1);
  } finally { s.restore(); }
});

test("AUTO_REPLY off: stored, not answered", async () => {
  const s = setup();
  s.env.AUTO_REPLY = "off";
  try {
    await quiet(() => onRequestPost({ request: form(), env: s.env }));
    assert.equal(rows(s.env, "in").length, 1);
    assert.equal(s.sent.length, 1);
  } finally { s.restore(); }
});

test("non-ASCII names, subjects and file names survive the round trip", async () => {
  const raw = contactEml({ mailbox: "ops", name: "Ọlá \"Ade\"", email: "ola@example.org", subject: "[Binchika · Verifier question] Ìbéèrè nípa ìjókòó", text: "Ẹ káàsán.\nLine two.", messageId: "<contact-1@binchika.com>",
    files: [{ filename: "fọ́tò.png", type: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }] });
  const p = await PostalMime.parse(raw);
  assert.equal(p.from.address, "ola@example.org");
  assert.equal(p.from.name, "Ọlá  Ade");
  assert.equal(p.subject, "[Binchika · Verifier question] Ìbéèrè nípa ìjókòó");
  assert.equal(p.text.trim(), "Ẹ káàsán.\nLine two.");
  assert.equal(p.to[0].address, "ops@binchika.com");
  assert.equal(p.attachments[0].filename, "fọ́tò.png");
  assert.equal(p.attachments[0].content.byteLength, 4);
});
