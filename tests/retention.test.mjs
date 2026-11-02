import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { purgeOldMail, MAIL_RETENTION_MIN_DAYS } from "../functions/_lib/mailsend.js";
import worker from "../workers/mailbox/src/index.js";

// A D1 stand-in on a real SQLite database with the real mailbox migration, so the retention SQL itself is tested.
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../db/d1/0004_mailbox.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { db, prepare: (sql) => stmt(sql), batch: async (list) => { db.exec("BEGIN"); try { for (const s of list) await s.run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } } };
}
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
function seed(D1, rows) {
  const ins = D1.db.prepare("INSERT INTO mail_messages (id, direction, mailbox, from_addr, to_addrs, raw_key, sent_by, at) VALUES (?, ?, 'ops', 'a@example.org', '[]', ?, ?, ?)");
  for (const [id, dir, raw, by, at] of rows) ins.run(id, dir, raw, by, at);
}
const ids = (D1) => D1.db.prepare("SELECT id FROM mail_messages ORDER BY id").all().map((r) => r.id);
const r2 = (log = [], fail = false) => ({ delete: async (keys) => { if (fail) throw new Error("R2 down"); log.push(...[keys].flat()); } });
const quiet = (fn) => async () => { const l = console.log, out = []; console.log = (s) => out.push(s); try { await fn(out); } finally { console.log = l; } };

test("retention: deletes Inbox, Sent and automatic replies older than the period, with their raw copies; keeps the rest", async () => {
  const D1 = sqliteD1(), removed = [];
  seed(D1, [
    ["old-in", "in", "mail/raw/old-in.eml", null, ago(400)],
    ["old-out", "out", null, "V0001", ago(366)],
    ["old-auto", "out", null, "auto-reply", ago(380)],
    ["edge-keep", "in", "mail/raw/edge.eml", null, ago(364)],
    ["new-in", "in", "mail/raw/new.eml", null, ago(1)],
  ]);
  const r = await purgeOldMail({ DB: D1, EVIDENCE: r2(removed) }, "365");
  assert.deepEqual(r, { deleted: 3, raw: 1 });
  assert.deepEqual(ids(D1), ["edge-keep", "new-in"]);
  assert.deepEqual(removed, ["mail/raw/old-in.eml"], "only the raw copy of a deleted message");
  assert.deepEqual(await purgeOldMail({ DB: D1, EVIDENCE: r2() }, "365"), { deleted: 0, raw: 0 }, "a second run finds nothing");
});

test("retention: works through large backlogs in batches", async () => {
  const D1 = sqliteD1(), removed = [];
  seed(D1, Array.from({ length: 123 }, (_, i) => [`m${String(i).padStart(3, "0")}`, "in", `mail/raw/m${i}.eml`, null, ago(500 + i)]));
  seed(D1, [["keep", "in", null, null, ago(10)]]);
  assert.deepEqual(await purgeOldMail({ DB: D1, EVIDENCE: r2(removed) }, 365, { batch: 50 }), { deleted: 123, raw: 123 });
  assert.equal(removed.length, 123);
  assert.deepEqual(ids(D1), ["keep"]);
  seed(D1, Array.from({ length: 30 }, (_, i) => [`x${i}`, "out", null, null, ago(400)]));
  assert.deepEqual(await purgeOldMail({ DB: D1, EVIDENCE: r2() }, 365, { batch: 10, maxBatches: 2 }), { deleted: 20, raw: 0 }, "at most maxBatches per run; the rest waits for the next day");
});

test("retention: refuses a missing, non-numeric or too-short period and deletes nothing", async () => {
  const D1 = sqliteD1();
  seed(D1, [["old", "in", "mail/raw/old.eml", null, ago(900)]]);
  for (const bad of [undefined, "", "abc", "12.5", "-365", "0", String(MAIL_RETENTION_MIN_DAYS - 1), "365 days"]) {
    const r = await purgeOldMail({ DB: D1, EVIDENCE: r2([], true) }, bad);
    assert.equal(r.deleted, 0, String(bad));
    assert.match(r.skipped, /^invalid retention/, String(bad));
  }
  assert.equal((await purgeOldMail({ DB: D1 }, "365")).skipped, "not configured");
  assert.deepEqual(ids(D1), ["old"]);
  assert.equal((await purgeOldMail({ DB: D1, EVIDENCE: r2() }, String(MAIL_RETENTION_MIN_DAYS))).deleted, 1, "30 days is allowed");
});

test("retention: if the raw copies cannot be deleted, the rows stay for the next run", async () => {
  const D1 = sqliteD1();
  seed(D1, [["old", "in", "mail/raw/old.eml", null, ago(400)]]);
  await assert.rejects(purgeOldMail({ DB: D1, EVIDENCE: r2([], true) }, "365"), /R2 down/);
  assert.deepEqual(ids(D1), ["old"]);
});

test("worker: the daily run purges with MAIL_RETENTION_DAYS, can be switched off, and never throws", quiet(async (out) => {
  const D1 = sqliteD1();
  seed(D1, [["old", "in", "mail/raw/old.eml", null, ago(400)], ["new", "in", null, null, ago(2)]]);
  await worker.scheduled({}, { DB: D1, EVIDENCE: r2(), MAIL_RETENTION_DAYS: "off" });
  assert.deepEqual(ids(D1), ["new", "old"], "off: nothing deleted");
  await worker.scheduled({}, { DB: D1, EVIDENCE: r2(), MAIL_RETENTION_DAYS: "365" });
  assert.deepEqual(ids(D1), ["new"]);
  await worker.scheduled({}, { DB: D1, EVIDENCE: r2(), MAIL_RETENTION_DAYS: "7" });
  await worker.scheduled({}, { DB: { prepare: () => { throw new Error("D1 down"); } }, EVIDENCE: r2(), MAIL_RETENTION_DAYS: "365" });
  const events = out.map((s) => JSON.parse(s));
  assert.deepEqual(events[0], { event: "mailbox-retention", skipped: "switched off" });
  assert.deepEqual(events[1], { event: "mailbox-retention", days: "365", deleted: 1, raw: 1 });
  assert.match(events[2].skipped, /invalid retention "7"/);
  assert.equal(events[3].event, "mailbox-retention-failed");
  assert.equal(out.some((s) => /@/.test(s)), false, "logs carry no addresses");
}));
