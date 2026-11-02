-- Session 88 (production-readiness gaps; docs/reports/2026-11-01-production-readiness.md). Additive only.
-- report_checks: the Form EC8A control-total check made on ingest, and the OCR proposal if the contained OCR path is
-- switched on. Numbers and reasons only: no names, handles, photos or captions. Deleted with its report.
CREATE TABLE IF NOT EXISTS report_checks (
  report_id     TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
  controls_json TEXT,                 -- the sheet's control totals as sent or as confirmed: register, accredited, rejected, …
  checks_ok     INTEGER NOT NULL DEFAULT 0 CHECK (checks_ok IN (0, 1)),   -- 1 only when the sheet balances (ec8a.js assessControls)
  checks_json   TEXT,                 -- the reasons when it does not
  ocr_status    TEXT CHECK (ocr_status IS NULL OR ocr_status IN ('off', 'proposed', 'withheld')),
  ocr_json      TEXT,                 -- model, version, input hash, transcript, per-field confidence (proposal only)
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- unit_consensus: why a unit was or was not posted (posting gates) and the per-unit baseline check.
ALTER TABLE unit_consensus ADD COLUMN gates_json TEXT;
ALTER TABLE unit_consensus ADD COLUMN baseline_json TEXT;
