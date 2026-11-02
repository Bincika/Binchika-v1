import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseKb, matchKb, enquiryText, replyText, pageText, kbDrift, helpHtml, NEVER_NATURES } from "../functions/_lib/kb.js";
import { KB as GENERATED } from "../functions/_lib/kb.generated.js";
import { onRequestGet } from "../functions/api/admin/tickets/index.js";

// Knowledge base, phase K1 (session 80). The real answer files, the real built pages, the real D1 migrations.
const KB = readdirSync(new URL("../src/kb/", import.meta.url)).filter((f) => f.endsWith(".md"))
  .map((f) => parseKb(readFileSync(new URL(`../src/kb/${f}`, import.meta.url), "utf8"), f)).sort((a, b) => a.order - b.order);
const best = (nature, text) => matchKb(KB, { nature, text })[0]?.id ?? null;

test("the answer files are valid, approved, never automatic, and the generated module matches them", () => {
  assert.ok(KB.length >= 5 && KB.length <= 8, `${KB.length} answers`);
  for (const e of KB) {
    assert.ok(e.approved && e.review_by && !e.auto_send, e.id);
    assert.ok(!e.topics.some((t) => NEVER_NATURES.includes(t)), e.id);
  }
  assert.deepEqual(GENERATED.map((e) => e.id), KB.map((e) => e.id), "rebuild after changing src/kb");
  assert.deepEqual(GENERATED.map((e) => e.body), KB.map((e) => e.body));
  assert.throws(() => parseKb('<!--{"id":"x","question":"q","topics":["data"],"match":{},"sources":[{"page":"/","must_contain":"a"}],"link":"/","approved":"y","review_by":"z"}-->\nText'), /never get a stock answer/);
  assert.throws(() => parseKb('<!--{"id":"x","question":"q","topics":["other"],"match":{},"sources":[{"page":"/","must_contain":"a"}],"link":"/","approved":"y","review_by":"z","auto_send":true}-->\nText'), /automatic sending/);
  assert.throws(() => parseKb('<!--{"id":"x","question":"q","topics":["other"],"match":{},"sources":[],"link":"/","approved":"y","review_by":"z"}-->\nText'), /source/);
});

test("matching: the real enquiry BIN-2610-0002 and other common questions", () => {
  assert.deepEqual(matchKb(KB, { nature: "verifier", text: "When can we expect verifiers to be selected" })[0], { id: "verifier-timeline", question: "When will verifiers be selected?", score: 1, matched: ["verif", "when", "select"] });
  assert.equal(best("verifier", "Is the verifier role paid? Do volunteers get an allowance?"), "verifier-role");
  assert.equal(best("other", "How do I check my name on the voters register? My photo is wrong."), "check-your-name");
  assert.equal(best("other", "Who won the presidential election? When will you announce the results?"), "results-who-won");
  assert.equal(best("other", "How can a tally in the ledger be corrected, and who can change it?"), "corrections");
  assert.equal(best("other", "What is Binchika? Are you part of INEC or the government?"), "what-is-binchika");
  assert.equal(best("other", "Do you support any party? Who funds the adverts?"), "neutrality");
});

test("matching never answers sensitive topics, never-words or unrelated questions", () => {
  for (const nature of NEVER_NATURES) assert.equal(best(nature, "When can we expect verifiers to be selected"), null, nature);
  assert.equal(best("verifier", "Please delete my data. When were verifiers selected?"), null);
  assert.equal(best("technical", "The map does not load on my phone"), null);
  assert.equal(best("other", "Hello"), null);
  assert.equal(best("verifier", "verifiers"), null, "below the threshold without a question word");
});

test("the reply for BIN-2610-0002 is the approved draft, with the aligned screening line", () => {
  const e = KB.find((x) => x.id === "verifier-timeline");
  const r = replyText(e, "BIN-2610-0002");
  assert.ok(r.startsWith("Hello,\n\nThank you for asking. Applications to become a Binchika verifier are not open yet. They open only once our privacy notice is in force, and we will announce the date on binchika.com/verifiers and on @getbinchika.\n\n"));
  assert.match(r, /• Applications: a two-week window, proposed for 2–16 November 2026\. Late applications are never reviewed\./);
  assert.match(r, /• Screening: proposed for 17 November – 4 December/);
  assert.match(r, /the holiday pause and the election days \(16 January and 6 February 2027\) do not move\./);
  assert.ok(r.endsWith("\n\nYour reference is BIN-2610-0002. If this does not answer your question, just reply and a person will help."));
  assert.doesNotMatch(r, /Binchika Ops/, "the dashboard template adds the sign-off");
  assert.doesNotMatch(replyText(e, "<script>"), /reference is/);
});

test("drift check: every source sentence is on today's built pages, and a changed page is caught", () => {
  const read = (page) => readFileSync(new URL(`../site${page === "/" ? "/" : page}index.html`, import.meta.url), "utf8");
  assert.deepEqual(kbDrift(KB, read), []);
  const changed = (page) => read(page).replace("2–16 November 2026", "9–23 November 2026");
  const d = kbDrift(KB, changed);
  assert.equal(d.length, 1);
  assert.match(d[0], /verifier-timeline: "Application window: two weeks, 2–16 November 2026 \(proposed\)\." is no longer on \/verifiers\//);
  assert.match(kbDrift([{ id: "x", sources: [{ page: "/nope/", must_contain: "a" }] }], () => { throw new Error("missing"); })[0], /page \/nope\/ not found/);
});

test("page text: inline tags leave no gap, blocks do, entities decoded", () => {
  assert.equal(pageText("<p>Choose your <strong>state → ward</strong>, or type.</p><p>INEC&#39;s <em>own</em>&nbsp;site &amp; more</p>"), "Choose your state → ward, or type. INEC's own site & more");
  assert.equal(pageText("<ul><li>One</li><li>Two</li></ul>"), "One Two");
});

test("help page HTML: intro line and bullets; bullets followed by text are refused; text is escaped", () => {
  const h = helpHtml([{ id: "a", question: "Q <b>?", link: "/x/", body: "Intro:\n• One\n• Two & three\n\nEnd." }]);
  assert.match(h, /<summary><h2>Q &lt;b&gt;\?<\/h2><\/summary><p>Intro:<\/p><ul class="tick-list"><li>One<\/li><li>Two &amp; three<\/li><\/ul><p>End\.<\/p>/);
  assert.throws(() => helpHtml([{ id: "b", question: "Q", link: "/", body: "• One\nthen text" }]), /bullet lines/);
});

test("enquiry text drops the form's header and footer lines and the subject tag", () => {
  const t = enquiryText("[BIN-2610-0002 · Verifier question] When can we expect", "Reference: BIN-2610-0002\nNature: Verifier question\nFrom: A <a@example.org>\nSent: 30/10/2026\nAttachments: 1\n\nWhen can we expect verifiers to be selected\n\n— Sent via the contact form at binchika.com/contact/");
  assert.doesNotMatch(t, /Reference|Nature|a@example\.org|Sent via|BIN-/);
  assert.match(t, /When can we expect verifiers to be selected/);
});

test("Tickets API: suggestion returned, message text never returned", async () => {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0004_mailbox.sql", "0007_tickets.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) ?? null, run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }) });
  const DB = { prepare: (sql) => stmt(sql) };
  db.prepare("INSERT INTO mail_messages (id, direction, mailbox, from_addr, to_addrs, subject, body_text) VALUES ('m1', 'in', 'ops', 'private.person@example.org', '[]', '[BIN-2610-0002 · Verifier question] When can we expect verifiers to be selected', 'Reference: BIN-2610-0002\nFrom: Private Person <private.person@example.org>\n\nWhen can we expect verifiers to be selected')").run();
  db.prepare("INSERT INTO mail_messages (id, direction, mailbox, from_addr, to_addrs, subject, body_text) VALUES ('m2', 'in', 'accounts', 'x@example.org', '[]', '[BIN-2610-0003 · Data request] delete my data', 'Please delete my data')").run();
  db.prepare("INSERT INTO tickets (ref, mail_id, nature, mailbox, due_at) VALUES ('BIN-2610-0002', 'm1', 'verifier', 'ops', '2026-11-03T00:00:00Z'), ('BIN-2610-0003', 'm2', 'data', 'accounts', '2026-11-03T00:00:00Z')").run();
  const real = globalThis.fetch;
  const token = `x.${Buffer.from(JSON.stringify({ aal: "aal2" })).toString("base64url")}.y`;
  globalThis.fetch = async (url) => {
    const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
    if (String(url).endsWith("/auth/v1/user")) return ok({ id: "u", email: "admin@example.org" });
    if (String(url).includes("/rest/v1/verifiers?")) return ok([{ role: "superadmin", public_id: "V0001" }]);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const env = { SUPABASE_URL: "https://s.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", DB };
    const r = await onRequestGet({ request: new Request("https://binchika.com/api/admin/tickets", { headers: { authorization: `Bearer ${token}` } }), env });
    assert.equal(r.status, 200);
    const raw = await r.text();
    assert.doesNotMatch(raw, /private\.person|Private Person|When can we expect|delete my data/, "no message text, sender or subject in the response");
    const j = JSON.parse(raw);
    const t2 = j.tickets.find((t) => t.ref === "BIN-2610-0002");
    assert.equal(t2.kb.id, "verifier-timeline");
    assert.match(t2.kb.reply, /Your reference is BIN-2610-0002\./);
    assert.equal(j.tickets.find((t) => t.ref === "BIN-2610-0003").kb, null, "data requests never get a suggestion");
  } finally { globalThis.fetch = real; }
});
