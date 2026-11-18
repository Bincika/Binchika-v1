// The correction-guard migration as the tests use it (session 212). Since the owner authorised the file (D1-m), the tests
// load the real db/d1/0011_correction_guard.sql, so what is tested is what would be applied. It is applied only to the
// in-memory SQLite databases of the tests, never to any Cloudflare database.
// No personal data: units, races, tallies, hashes, times and a flag UUID only.
import { readFileSync as readMigration } from "node:fs";
export const CORRECTION_GUARD_SCHEMA = readMigration(new URL("../../db/d1/0011_correction_guard.sql", import.meta.url), "utf8");

// The backfill statement, taken from the same file (its last statement): a unit's correction_hash is set only where its
// latest ledger entry is a correction. It is re-run once straight after the deploy (Gate 1, N1).
export const CORRECTION_GUARD_BACKFILL = CORRECTION_GUARD_SCHEMA.slice(CORRECTION_GUARD_SCHEMA.indexOf("UPDATE unit_consensus SET correction_hash"));
if (!CORRECTION_GUARD_BACKFILL.startsWith("UPDATE")) throw new Error("the backfill statement is missing from 0011_correction_guard.sql");

// The D1 shim the tests share: real SQLite, with batch() as one transaction (BEGIN, each statement, COMMIT; ROLLBACK on the
// first error), returning [{ meta: { changes } }] as D1 does. hooks.afterFirst(sql) lets a test change the database between
// a read and the write that follows it.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function sqliteD1({ guard = true, hooks = {} } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_ledger.sql", "0005_evidence.sql", "0008_report_checks.sql"]) db.exec(readFileSync(new URL(`../../db/d1/${f}`, import.meta.url), "utf8"));
  if (guard) db.exec(CORRECTION_GUARD_SCHEMA);
  const exec = (sql, args) => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; };
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => { const row = db.prepare(sql).get(...args) ?? null; if (hooks.afterFirst) await hooks.afterFirst(sql, D1); return row; },
    run: async () => exec(sql, args),
  });
  const D1 = {
    db,
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      if (hooks.beforeBatch) await hooks.beforeBatch(stmts, D1);
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => (/^\s*SELECT/i.test(s.sql) ? (db.prepare(s.sql).all(...s.args), { meta: { changes: 0 } }) : exec(s.sql, s.args)));
        db.exec("COMMIT");
        return out;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
  return D1;
}
