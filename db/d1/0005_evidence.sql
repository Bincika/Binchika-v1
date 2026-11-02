-- Evidence type and verifier audit for citizen reports (session 55; docs/EVIDENCE-AUDIT.md). Additive only.
-- evidence: what the report shows. 'ec8a' = the posted result sheet (default, and every existing row).
--   'video' | 'handwritten' | 'board' = alternatives accepted only when Form EC8A is not available.
-- audit_status: NULL for result-sheet reports; 'pending' → 'approved' | 'rejected' for alternatives, decided by an
--   SZV/NRV for that state (POST /api/portal/evidence). Approved alternatives can make a unit "lower" (lower-confidence),
--   never "high", so they never reach the ledger or the results on their own (functions/_lib/consensus.js unitConsensus).
ALTER TABLE reports ADD COLUMN evidence TEXT NOT NULL DEFAULT 'ec8a' CHECK (evidence IN ('ec8a','video','handwritten','board'));
ALTER TABLE reports ADD COLUMN audit_status TEXT CHECK (audit_status IS NULL OR audit_status IN ('pending','approved','rejected'));
ALTER TABLE reports ADD COLUMN audited_by TEXT;     -- public ID of the auditing verifier (e.g. V0042), never a name
ALTER TABLE reports ADD COLUMN audited_at TEXT;
ALTER TABLE reports ADD COLUMN audit_note TEXT;     -- the verifier's reason, at most 500 characters
CREATE INDEX IF NOT EXISTS idx_reports_audit ON reports (audit_status) WHERE audit_status = 'pending';
