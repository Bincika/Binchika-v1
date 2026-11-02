-- Public, append-only, hash-chained ledger. seq is the chain position: the PRIMARY KEY makes two
-- concurrent appends at the same position impossible (the loser retries on the new head).
CREATE TABLE IF NOT EXISTS ledger_entries (
  seq          INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('tally', 'correction')),
  pu_code      TEXT NOT NULL,
  race         TEXT NOT NULL,
  state_iso    TEXT,
  body_json    TEXT NOT NULL,       -- canonical entry without hash (what the hash covers, minus prev/recordedAt)
  prev         TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  recorded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_unit ON ledger_entries (pu_code, race);
CREATE INDEX IF NOT EXISTS idx_ledger_state ON ledger_entries (state_iso);

-- Append-only: block edits and deletes at the database level.
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
