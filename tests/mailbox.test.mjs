import { test } from "node:test";
import assert from "node:assert/strict";
import { MAILBOXES, fromHeader, validateSend, textToHtml, htmlToText, mailboxOf, replySubject, splitAddrs } from "../functions/_lib/mailbox.js";
import { sendFromDashboard, DAILY_LIMIT } from "../functions/_lib/mailsend.js";
import { general } from "../functions/_lib/emails.js";
import { storeCopy } from "../workers/mailbox/src/index.js";

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

test("mailbox: exactly the three approved From addresses", () => {
  assert.deepEqual(Object.values(MAILBOXES).map((m) => m.address).sort(), ["accounts@mail.example.org", "noreply@mail.example.org", "ops@mail.example.org"]);
  assert.equal(fromHeader("ops"), "Binchika Ops <ops@mail.example.org>");
});

test("mailbox: send validation", () => {
  assert.equal(validateSend({ from: "ops", to: "a@example.org", subject: "Hi", body: "Hello" }).ok, true);
  assert.match(validateSend({ from: "ceo", to: "a@example.org", subject: "Hi", body: "x" }).errors.join(), /From/);
  assert.match(validateSend({ from: "ops@mail.example.org", to: "a@example.org", subject: "Hi", body: "x" }).errors.join(), /From/, "keys only, not raw addresses");
  assert.match(validateSend({ from: "ops", to: "", subject: "Hi", body: "x" }).errors.join(), /recipient/);
  assert.match(validateSend({ from: "ops", to: "not-an-address", subject: "Hi", body: "x" }).errors.join(), /not an email/);
  assert.match(validateSend({ from: "ops", to: Array(11).fill("a@example.org").join(","), subject: "Hi", body: "x" }).errors.join(), /at most 10/);
  assert.match(validateSend({ from: "ops", to: "a@example.org", subject: "", body: "x" }).errors.join(), /subject/);
  assert.equal(validateSend({ from: "ops", to: "a@example.org", subject: "A\r\nBcc: x@evil.test", body: "x" }).mail.subject, "A Bcc: x@evil.test", "no header injection");
  assert.deepEqual(splitAddrs("A <a@example.org>; b@example.org,\n"), ["a@example.org", "b@example.org"]);
  assert.equal(validateSend({ from: "ops", to: "a@example.org", subject: "s", body: "b", inReplyTo: "bad value" }).mail.inReplyTo, null);
});

test("mailbox: text and HTML helpers", () => {
  const h = textToHtml("Hello <b>there</b>\nline two\n\nSee https://binchika.com/vote/.");
  assert.match(h, /&lt;b&gt;there&lt;\/b&gt;<br>line two<\/p><p/);
  assert.match(h, /<a href="https:\/\/binchika.com\/vote\/"/);
  assert.match(textToHtml('x" onmouseover="y'), /x&quot; onmouseover=&quot;y/);
  assert.equal(htmlToText("<style>p{}</style><p>One&amp;two</p><p>Three<br>four</p>"), "One&two\nThree\nfour");
  assert.equal(mailboxOf(["someone@example.org", "OPS@mail.example.org"]), "ops");
  assert.equal(mailboxOf("x@example.org"), null);
  assert.equal(replySubject("Re: hello"), "Re: hello");
  assert.equal(replySubject("hello"), "Re: hello");
});

test("template: general() uses the official agogo logo and escapes the sign-off", () => {
  const g = general({ subject: "Hello", bodyHtml: "<p>Body</p>", signOff: "Binchika <Ops>", from: "ops@mail.example.org" });
  assert.match(g.html, /agogo-128\.png/);
  assert.match(g.html, /Binchika &lt;Ops&gt;/);
  assert.match(g.html, /Only EEC declares election results/);
  assert.doesNotMatch(g.html, /applied to volunteer/);
});

test("send: Resend gets the chosen From, branded HTML and a text part; the Sent row is stored", async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), new Response(JSON.stringify({ id: "re_123" }), { status: 200 }));
  const DB = fakeDB([{ n: 0 }]);
  const r = await sendFromDashboard({ RESEND_API_KEY: "k", DB }, { from: "accounts", to: "party@example.org", subject: "Manifesto", body: "Dear party,\n\nThank you." }, "V0001");
  assert.equal(r.status, 200);
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.equal(sent[0].body.from, "Binchika Accounts <accounts@mail.example.org>");
  assert.match(sent[0].body.html, /agogo-128\.png/);
  assert.match(sent[0].body.text, /Thank you\.\n\nBinchika Accounts/);
  const insert = DB.calls.find((c) => /INSERT INTO mail_messages/.test(c.sql));
  assert.equal(insert.args[1], "accounts");
  assert.equal(insert.args[10], "re_123");
  assert.equal(insert.args[11], "V0001");
});

test("send: reply threads under the original and quotes it; refusals send nothing", async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => (sent.push(JSON.parse(init.body)), new Response(JSON.stringify({ id: "re_9" }), { status: 200 }));
  const original = { id: "m1", from_addr: "v@example.org", from_name: "V", subject: "Question", body_text: "Is <this> right?", message_id: "<abc@example.org>", at: "2026-10-28T10:00:00Z" };
  const r = await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB([original, { n: 0 }]) }, { from: "ops", to: "v@example.org", body: "Yes.", replyToId: "m1" }, "V0001");
  assert.equal(r.status, 200);
  assert.equal(sent[0].subject, "Re: Question");
  assert.deepEqual(sent[0].headers, { "In-Reply-To": "<abc@example.org>", References: "<abc@example.org>" });
  assert.match(sent[0].html, /Is &lt;this&gt; right\?/);
  assert.match(sent[0].text, /> Is <this> right\?/);

  sent.length = 0;
  assert.equal((await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB([null]) }, { from: "ops", body: "x", replyToId: "nope" })).status, 404);
  assert.equal((await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB([{ n: DAILY_LIMIT }]) }, { from: "ops", to: "a@example.org", subject: "s", body: "b" })).status, 429);
  assert.equal((await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB([{ n: 0 }]) }, { from: "boss", to: "a@example.org", subject: "s", body: "b" })).status, 422);
  assert.equal((await sendFromDashboard({ DB: fakeDB() }, { from: "ops", to: "a@example.org", subject: "s", body: "b" })).status, 503);
  const pv = await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB() }, { from: "noreply", to: "a@example.org", subject: "s", body: "b", dryRun: true });
  assert.equal(pv.status, 200);
  assert.match(pv.body.preview, /agogo-128\.png/);
  assert.equal(sent.length, 0, "refusals and previews send nothing");
});

test("worker: storeCopy keeps the raw message in R2 and the parsed fields in D1", async () => {
  const raw = new TextEncoder().encode([
    "From: Ada Verifier <ada@example.org>", "To: ops@mail.example.org", "Subject: Seat question", "Message-ID: <m-1@example.org>",
    "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain; charset=utf-8", "",
    "Hello Ops,", "Can I change my seat?", "--b", 'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"', "",
    "attached", "--b--", "",
  ].join("\r\n")).buffer;
  const put = [];
  const DB = fakeDB();
  const r = await storeCopy({ DB, EVIDENCE: { put: async (k, v) => put.push(k) } }, raw, "ops@mail.example.org");
  assert.match(put[0], /^mail\/raw\/[0-9a-f-]{36}\.eml$/);
  const a = DB.calls[0].args;
  assert.equal(a[1], "ops");
  assert.equal(a[2], "ada@example.org");
  assert.equal(a[6], "Seat question");
  assert.match(a[7], /Can I change my seat\?/);
  assert.equal(a[9], "<m-1@example.org>");
  assert.deepEqual(JSON.parse(a[11]), [{ filename: "note.txt", mimeType: "text/plain", size: 8 }]);
  assert.equal(r.attachments, 1);
});

test("attachments: types, size limit, filenames; passed to Resend and recorded as a manifest only", async () => {
  const { validateAttachments, MAX_ATTACH_BYTES, safeFilename } = await import("../functions/_lib/mailbox.js");
  const pdf = { filename: "report.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4 test").toString("base64") };
  assert.equal(validateAttachments([pdf]).ok, true);
  assert.equal(validateAttachments([pdf]).files[0].size, 13);
  assert.match(validateAttachments([{ ...pdf, contentType: "application/x-msdownload", filename: "setup.exe" }]).errors.join(), /not accepted: setup\.exe/);
  assert.match(validateAttachments([{ ...pdf, content: "not base64!" }]).errors.join(), /could not be read/);
  assert.match(validateAttachments(Array(11).fill(pdf)).errors.join(), /at most 10/);
  const big = "A".repeat(Math.ceil(((MAX_ATTACH_BYTES + 3) * 4) / 3 / 4) * 4);
  assert.match(validateAttachments([{ ...pdf, content: big }]).errors.join(), /limit is 15 MB/);
  assert.equal(safeFilename(String.raw`..\..//etc/pass*wd.pdf`), "_.._etc_pass_wd.pdf");
  assert.equal(validateAttachments(undefined).ok, true, "no attachments is fine");

  const sent = [];
  globalThis.fetch = async (url, init) => (sent.push(JSON.parse(init.body)), new Response(JSON.stringify({ id: "re_att" }), { status: 200 }));
  const DB = fakeDB([{ n: 0 }]);
  const r = await sendFromDashboard({ RESEND_API_KEY: "k", DB }, { from: "ops", to: "a@example.org", subject: "Files", body: "See attached.", attachments: [pdf] }, "V0001");
  assert.equal(r.status, 200);
  assert.equal(r.body.attachments, 1);
  assert.deepEqual(sent[0].attachments, [{ filename: "report.pdf", content: pdf.content, content_type: "application/pdf" }]);
  const insert = DB.calls.find((c) => /INSERT INTO mail_messages/.test(c.sql));
  assert.deepEqual(JSON.parse(insert.args[12]), [{ filename: "report.pdf", mimeType: "application/pdf", size: 13 }], "manifest only, no file content in D1");
  assert.equal(insert.args.some((a) => String(a).includes(pdf.content)), false);

  sent.length = 0;
  const bad = await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB([{ n: 0 }]) }, { from: "ops", to: "a@example.org", subject: "s", body: "b", attachments: [{ ...pdf, contentType: "application/zip" }] });
  assert.equal(bad.status, 422);
  assert.equal(sent.length, 0, "a refused attachment sends nothing");
  const pv = await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB() }, { from: "ops", to: "a@example.org", subject: "s", body: "b", attachments: [pdf], dryRun: true });
  assert.deepEqual(pv.body.attachments, [{ filename: "report.pdf", mimeType: "application/pdf", size: 13 }]);
  assert.equal(sent.length, 0, "preview sends nothing");
});

test("delete: removes the D1 row and the raw .eml in R2; unknown id is 404", async () => {
  const { deleteMail } = await import("../functions/_lib/mailsend.js");
  const removed = [];
  const DB = fakeDB([{ id: "m1", raw_key: "mail/raw/m1.eml" }]);
  const r = await deleteMail({ DB, EVIDENCE: { delete: async (k) => removed.push(k) } }, "m1");
  assert.equal(r.status, 200);
  assert.deepEqual(removed, ["mail/raw/m1.eml"]);
  assert.ok(DB.calls.some((c) => /DELETE FROM mail_messages WHERE id = \?1/.test(c.sql) && c.args[0] === "m1"));
  const sentRow = await deleteMail({ DB: fakeDB([{ id: "s1", raw_key: null }]), EVIDENCE: { delete: async () => assert.fail("no R2 object for a sent row") } }, "s1");
  assert.equal(sentRow.status, 200);
  assert.equal((await deleteMail({ DB: fakeDB([null]), EVIDENCE: {} }, "nope")).status, 404);
  assert.equal((await deleteMail({}, "x")).status, 503);
});

// Session 141: optional BCC. Validated like To and Cc, sent to the provider only, never stored.
test("bcc: several addresses are accepted and normalised; empty behaves as before", () => {
  const v = validateSend({ from: "ops", to: "a@example.org", cc: "c@example.org", bcc: "B One <b1@example.org>; b2@example.org,\nb3@example.org", subject: "Hi", body: "Hello" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.mail.bcc, ["b1@example.org", "b2@example.org", "b3@example.org"]);
  assert.deepEqual(validateSend({ from: "ops", to: "a@example.org", subject: "Hi", body: "Hello" }).mail.bcc, []);
});

test("bcc: malformed, too many or duplicate addresses are refused, never dropped", () => {
  const base = { from: "ops", to: "a@example.org", subject: "Hi", body: "x" };
  assert.match(validateSend({ ...base, bcc: "not-an-address" }).errors.join(), /not an email/);
  assert.match(validateSend({ ...base, cc: "c@example.org", bcc: Array.from({ length: 9 }, (_, i) => `b${i}@example.org`).join(",") }).errors.join(), /at most 10/);
  assert.equal(validateSend({ ...base, bcc: Array.from({ length: 9 }, (_, i) => `b${i}@example.org`).join(",") }).ok, true, "1 To + 9 Bcc is the limit");
  assert.match(validateSend({ ...base, bcc: "b@example.org, B@Example.org" }).errors.join(), /listed more than once: b@example\.org/i);
  assert.match(validateSend({ ...base, bcc: "A@example.org" }).errors.join(), /listed more than once/i, "also in To");
  assert.match(validateSend({ ...base, cc: "c@example.org", bcc: "c@example.org" }).errors.join(), /listed more than once/i, "also in Cc");
});

test("bcc: Resend receives it; the Sent row, the stored text and the response do not", async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => (sent.push(JSON.parse(init.body)), new Response(JSON.stringify({ id: "re_b" }), { status: 200 }));
  const DB = fakeDB([{ n: 0 }]);
  const r = await sendFromDashboard({ RESEND_API_KEY: "k", DB }, { from: "ops", to: "a@example.org", cc: "c@example.org", bcc: "hidden1@example.org, hidden2@example.org", subject: "Hi", body: "Hello" }, "V0001");
  assert.equal(r.status, 200);
  assert.deepEqual(sent[0].bcc, ["hidden1@example.org", "hidden2@example.org"]);
  assert.deepEqual(sent[0].to, ["a@example.org"]);
  assert.deepEqual(sent[0].cc, ["c@example.org"]);
  assert.ok(!/hidden[12]@example\.org/.test(sent[0].html + sent[0].text), "not in the message itself");
  const insert = DB.calls.find((c) => /INSERT INTO mail_messages/.test(c.sql));
  assert.equal(insert.args.length, 13, "same 13 bound values as before");
  assert.ok(!/bcc/i.test(insert.sql), "no bcc column");
  assert.ok(!/hidden[12]@/.test(JSON.stringify(insert.args)), "no BCC address is stored");
  assert.ok(!/hidden[12]@/.test(JSON.stringify(r.body)), "nor echoed in the response");
  // No BCC: the provider payload has no bcc key at all, as before.
  sent.length = 0;
  await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB([{ n: 0 }]) }, { from: "ops", to: "a@example.org", subject: "Hi", body: "Hello" }, "V0001");
  assert.equal("bcc" in sent[0], false);
});

test("bcc: an invalid BCC sends nothing; a reply with BCC keeps its threading; a dry run shows it and sends nothing", async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => (sent.push(JSON.parse(init.body)), new Response(JSON.stringify({ id: "re_c" }), { status: 200 }));
  const bad = await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB([{ n: 0 }]) }, { from: "ops", to: "a@example.org", bcc: "oops", subject: "Hi", body: "Hello" }, "V0001");
  assert.equal(bad.status, 422);
  assert.equal(sent.length, 0, "never sent without the BCC");
  const original = { id: "m1", from_addr: "asker@example.org", from_name: "Asker", subject: "Question", body_text: "When?", message_id: "<orig@example.org>", at: "2026-11-01T10:00:00.000Z" };
  const rep = await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB([original, { n: 0 }]) }, { from: "ops", to: "asker@example.org", bcc: "hidden@example.org", subject: "Re: Question", body: "Soon.", replyToId: "m1" }, "V0001");
  assert.equal(rep.status, 200);
  assert.deepEqual(sent[0].bcc, ["hidden@example.org"]);
  assert.equal(sent[0].headers["In-Reply-To"], "<orig@example.org>");
  sent.length = 0;
  const dry = await sendFromDashboard({ RESEND_API_KEY: "k", DB: fakeDB([]) }, { from: "ops", to: "a@example.org", bcc: "hidden@example.org", subject: "Hi", body: "Hello", dryRun: true }, "V0001");
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.bcc, ["hidden@example.org"]);
  assert.equal(sent.length, 0);
});

test("bcc: the compose form has the field and every draft and request carries it", async () => {
  const { readFileSync } = await import("node:fs");
  const js = readFileSync(new URL("../site/assets/js/portal.js", import.meta.url), "utf8");
  assert.ok(js.includes('<label class="wide">Bcc (optional)<input id="mc-bcc" autocomplete="off"'));
  assert.ok(js.indexOf('id="mc-cc"') < js.indexOf('id="mc-bcc"') && js.indexOf('id="mc-bcc"') < js.indexOf('id="mc-subject"'), "after Cc, before Subject");
  assert.ok(js.includes('bcc: $("mc-bcc").value'), "saveDraft keeps it");
  assert.ok(/JSON\.stringify\(\{ from: d\.from, to: d\.to, cc: d\.cc, bcc: d\.bcc, subject/.test(js), "the request sends it");
  assert.equal((js.match(/to: m\.from_addr, cc: "", bcc: ""/g) ?? []).length, 3, "the three reply drafts start with an empty BCC");
  assert.ok(js.includes('<select id="mc-from">'), "From dropdown untouched");
});
