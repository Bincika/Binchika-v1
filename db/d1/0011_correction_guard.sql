-- Session 212: correction-path hardening (build plan 8, docs/CORRECTION-PATH-BUILD-PLAN.md section 4; design note
-- docs/CORRECTION-PATH-HARDENING.md). Owner decision D1-m: written and tested on a local database only; it is applied to
-- production only on the owner's separate word, and the deploy follows at once (Gate 1, N1).
-- Additive only: two new tables and one nullable column. No existing row, column, index or trigger changes; the ledger
-- (ledger_entries, its hash chain and its append-only triggers) is not touched. Nothing is ever deleted from these tables:
-- conflicts are resolved, never removed. No personal data: units, races, tallies, hashes, times and a flag UUID only.
-- Until this migration exists the code fails closed (functions/_lib/correction-guard.js): approving a correction answers
-- 503, and processUnit runs exactly its earlier path.

-- One correction per flag: written in the same D1 batch as the correction entry, so a second approval of the same flag
-- fails on the primary key and the whole batch rolls back.
CREATE TABLE IF NOT EXISTS correction_claims (
  flag_id     TEXT PRIMARY KEY,                -- Supabase discrepancy_flags.id; names no person
  pu_code     TEXT NOT NULL,
  race        TEXT NOT NULL,
  ledger_hash TEXT NOT NULL,                   -- the correction entry this claim produced
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The unit's latest standing correction. A unit counts as corrected only while correction_hash = ledger_hash.
ALTER TABLE unit_consensus ADD COLUMN correction_hash TEXT;

-- A later recount that disagrees with a standing correction. The correction stays; a person decides through the normal
-- three-seat flag chain with a new correction entry (owner decision D3). Admins only (owner decision D2).
CREATE TABLE IF NOT EXISTS correction_conflicts (
  id                INTEGER PRIMARY KEY,
  pu_code           TEXT NOT NULL,
  race              TEXT NOT NULL,
  correction_hash   TEXT NOT NULL,
  recomputed_json   TEXT,
  recomputed_status TEXT NOT NULL,
  recomputed_hash   TEXT NOT NULL,
  detected_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at       TEXT,
  resolved_by_hash  TEXT,
  UNIQUE (correction_hash, recomputed_hash)
);

-- Backfill: a unit whose latest ledger entry is a correction carries that correction's hash. The production ledger count
-- was 0 when this was written, so this is expected to change 0 rows. Re-run this one statement straight after the
-- deploy (Gate 1, N1), in case the old code wrote a correction in between.
UPDATE unit_consensus SET correction_hash = (
  SELECT l.hash FROM ledger_entries l WHERE l.pu_code = unit_consensus.pu_code AND l.race = unit_consensus.race ORDER BY l.seq DESC LIMIT 1
) WHERE (
  SELECT l.kind FROM ledger_entries l WHERE l.pu_code = unit_consensus.pu_code AND l.race = unit_consensus.race ORDER BY l.seq DESC LIMIT 1
) = 'correction';
