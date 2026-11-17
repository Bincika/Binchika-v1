-- Session 111: precomputed public totals, one row per race (docs/results-precomputed-totals.md).
-- Derived and disposable: built from unit_consensus by workers/results-snapshot. Public aggregates only; no personal data.
-- Touches no existing column or row, and is not part of the ledger.
CREATE TABLE IF NOT EXISTS results_snapshot (
  race              TEXT PRIMARY KEY,
  body_json         TEXT NOT NULL,      -- the public response body, without builtAt and updatedAt
  units             INTEGER NOT NULL,
  source_updated_at TEXT,               -- newest unit_consensus.updated_at for the race, read before the build began
  built_at          TEXT NOT NULL,      -- when the build began
  format            INTEGER NOT NULL    -- RESULTS_BODY_VERSION: a new version rebuilds the row
);
-- The Worker's paged read, and its "has anything changed?" check. Neither scans.
CREATE INDEX IF NOT EXISTS idx_unit_consensus_race_status ON unit_consensus (race, status, pu_code);
CREATE INDEX IF NOT EXISTS idx_unit_consensus_race_updated ON unit_consensus (race, updated_at);
