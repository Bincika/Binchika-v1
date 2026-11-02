-- Binchika D1 schema (edge store for raw citizen reports and processing state).
-- Apply: npx wrangler d1 migrations apply binchika-db --remote   (migrations_dir = db/d1)
-- No PII: reporters are stored only as salted SHA-256 hashes.

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,               -- uuid
  channel       TEXT NOT NULL CHECK (channel IN ('telegram','whatsapp','x','instagram','threads','discord','web','sms','other')),
  reporter_hash TEXT NOT NULL,                  -- sha256(salt + channel + handle)
  pu_code       TEXT,                           -- INEC polling unit code if known, e.g. 24-09-05-012
  race          TEXT CHECK (race IN ('president','senate','house','governor','state-assembly')),
  media_ref     TEXT,                           -- channel file id / URL (never a person's photo)
  media_sha256  TEXT,
  caption       TEXT,
  tally_json    TEXT,                           -- {"PARTY": votes} once read
  status        TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','ocr_pending','ocr_done','needs_review','verified','rejected')),
  received_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_pu ON reports (pu_code, race);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);

CREATE TABLE IF NOT EXISTS official_results (
  pu_code     TEXT NOT NULL,
  race        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'IReV',
  tally_json  TEXT,
  document_url TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (pu_code, race, source)
);

CREATE TABLE IF NOT EXISTS unit_consensus (
  pu_code      TEXT NOT NULL,
  race         TEXT NOT NULL,
  status       TEXT NOT NULL,                   -- high | medium | low | insufficient
  share        REAL NOT NULL,
  reports      INTEGER NOT NULL,
  tally_json   TEXT,
  discrepancy_json TEXT,
  ledger_hash  TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (pu_code, race)
);

CREATE TABLE IF NOT EXISTS bulletin (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('discrepancy','issue','update','correction')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  source_url  TEXT,
  scope       TEXT,                             -- e.g. NG-LA or pu code
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
