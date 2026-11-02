import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { yymmOf, refOf, dueAfter, nextRef, openTicket, listTickets, updateTicket } from "../functions/_lib/tickets.js";
import { autoReplyMail } from "../functions/_lib/autoreply.js";
import { subjectFor } from "../functions/_lib/contact.js";

// Ticketed enquiries, phase 1 (session 78). Real SQLite with the real D1 migrations (foreign keys on, as in D1).
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0004_mailbox.sql", "0007_tickets.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { db, prepare: (sql) => stmt(sql) };
}
const mailRow = (D1, id) => D1.db.prepare("INSERT INTO mail_messages (id, direction, mailbox, from_addr, to_addrs, subject) VALUES (?, 'in', 'ops', 'a@example.org', '[]', 's')").run(id);

test("references use the month in Lagos time and pad to four digits", () => {
  assert.equal(yymmOf(new Date("2026-10-31T22:30:00Z")), "2610");
  assert.equal(yymmOf(new Date("2026-10-31T23:30:00Z")), "2611", "00:30 on 1 Nov in Lagos is November");
  assert.equal(refOf("2611", 42), "BIN-2611-0042");
  assert.equal(refOf("2611", 12345), "BIN-2611-12345");
});

test("due dates skip weekends (two working days, Lagos time)", () => {
  assert.equal(dueAfter(new Date("2026-11-02T09:00:00Z")).toISOString(), "2026-11-04T09:00:00.000Z", "Monday → Wednesday");
  assert.equal(dueAfter(new Date("2026-11-06T09:00:00Z")).toISOString(), "2026-11-10T09:00:00.000Z", "Friday → Tuesday");
  assert.equal(dueAfter(new Date("2026-11-07T09:00:00Z")).toISOString(), "2026-11-10T09:00:00.000Z", "Saturday → Tuesday");
  assert.equal(dueAfter(new Date("2026-11-06T23:30:00Z")).toISOString(), "2026-11-09T23:30:00.000Z", "Friday 23:30 UTC is Saturday 00:30 in Lagos → Tuesday 00:30 Lagos");
});

test("numbers run in order and restart each month; never shared", async () => {
  const D1 = sqliteD1();
  const oct = new Date("2026-10-30T10:00:00Z"), nov = new Date("2026-11-02T10:00:00Z");
  const a = await Promise.all([nextRef(D1, oct), nextRef(D1, oct), nextRef(D1, oct)]);
  assert.deepEqual(a.sort(), ["BIN-2610-0001", "BIN-2610-0002", "BIN-2610-0003"]);
  assert.equal(await nextRef(D1, nov), "BIN-2611-0001");
  assert.equal(await nextRef(D1, oct), "BIN-2610-0004");
});

test("a ticket is deleted with its Inbox message (retention and Delete)", async () => {
  const D1 = sqliteD1();
  mailRow(D1, "m1");
  await openTicket(D1, { ref: "BIN-2611-0001", mailId: "m1", nature: "data", mailbox: "accounts" });
  await openTicket(D1, { ref: "BIN-2611-0002", mailId: null, nature: "press", mailbox: "noreply" });
  D1.db.prepare("DELETE FROM mail_messages WHERE id = 'm1'").run();
  assert.deepEqual(D1.db.prepare("SELECT ref FROM tickets").all().map((r) => r.ref), ["BIN-2611-0002"]);
  assert.throws(() => D1.db.prepare("INSERT INTO tickets (ref, mail_id, nature, mailbox, due_at) VALUES ('BIN-2611-0003', 'nope', 'x', 'ops', 'z')").run(), /FOREIGN KEY/);
});

test("list: newest first, counts by status, overdue only while open", async () => {
  const D1 = sqliteD1();
  await openTicket(D1, { ref: "BIN-2610-0001", nature: "data", mailbox: "accounts", now: new Date("2026-10-01T09:00:00Z") });
  await openTicket(D1, { ref: "BIN-2610-0002", nature: "error", mailbox: "ops", now: new Date("2026-10-02T09:00:00Z") });
  await updateTicket(D1, "BIN-2610-0002", { status: "answered" }, "V0001");
  const r = await listTickets(D1, { now: new Date("2026-10-30T09:00:00Z") });
  assert.deepEqual(r.tickets.map((t) => [t.ref, t.overdue]), [["BIN-2610-0002", false], ["BIN-2610-0001", true]]);
  assert.deepEqual(r.counts, { answered: 1, new: 1 });
  assert.equal((await listTickets(D1, { status: "new" })).tickets.length, 1);
});

test("updates: validated, closing stamps closed_at, reopening clears it, the actor is a public ID", async () => {
  const D1 = sqliteD1();
  await openTicket(D1, { ref: "BIN-2611-0001", nature: "data", mailbox: "accounts" });
  assert.equal((await updateTicket(D1, "nope", { status: "closed" }, "V0001")).status, 400);
  assert.equal((await updateTicket(D1, "BIN-2611-0001", { status: "deleted" }, "V0001")).status, 422);
  assert.equal((await updateTicket(D1, "BIN-2611-0001", { resolution: "x".repeat(501) }, "V0001")).status, 422);
  assert.equal((await updateTicket(D1, "BIN-2611-0001", {}, "V0001")).status, 400);
  assert.equal((await updateTicket(D1, "BIN-2611-9999", { status: "closed" }, "V0001")).status, 404);
  const c = await updateTicket(D1, "BIN-2611-0001", { status: "closed", resolution: "Answered by email." }, "V0001", new Date("2026-11-03T10:00:00Z"));
  assert.equal(c.status, 200);
  assert.equal(c.body.ticket.closed_at, "2026-11-03T10:00:00.000Z");
  assert.equal(c.body.ticket.owner_seat, "V0001");
  assert.equal(c.body.ticket.resolution, "Answered by email.");
  const again = await updateTicket(D1, "BIN-2611-0001", { status: "closed" }, "V0001", new Date("2026-11-04T10:00:00Z"));
  assert.equal(again.body.ticket.closed_at, "2026-11-03T10:00:00.000Z", "closing twice keeps the first date");
  const re = await updateTicket(D1, "BIN-2611-0001", { status: "in_progress" }, "V0001");
  assert.equal(re.body.ticket.closed_at, null);
  assert.equal(re.body.ticket.resolution, "Answered by email.", "the note is kept");
});

test("subject and automatic reply carry the reference; email without one is unchanged", () => {
  const f = { nature: "data", message: "Please send the data behind the Lagos register figures today." };
  assert.match(subjectFor(f, "BIN-2611-0042"), /^\[BIN-2611-0042 · Data request\] Please send/);
  assert.match(subjectFor(f), /^\[Binchika · Data request\]/);
  const withRef = autoReplyMail({ mailbox: "accounts", subject: "x", messageId: null, reference: "BIN-2611-0042" });
  assert.match(withRef.text, /Your reference is BIN-2611-0042\./);
  assert.match(withRef.html, /BIN-2611-0042/);
  const plain = autoReplyMail({ mailbox: "accounts", subject: "x", messageId: null });
  assert.doesNotMatch(plain.text, /reference/);
  const forged = autoReplyMail({ mailbox: "accounts", subject: "x", messageId: null, reference: "<script>BIN" });
  assert.doesNotMatch(forged.text, /reference|script/, "only a well-formed reference is ever printed");
});
