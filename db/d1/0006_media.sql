-- Evidence photo/video pipeline (session 58; functions/_lib/photo.js, docs/PHOTO-PIPELINE.md). Additive only.
-- After processing, reports.media_ref = 'r2:full/2027/<unit>/<report id>.<ext>' and media_sha256 = SHA-256 of the
-- processed file (what the evidence viewer checks). These columns record the rest:
ALTER TABLE reports ADD COLUMN original_sha256 TEXT;      -- SHA-256 of the file as received, before metadata removal
ALTER TABLE reports ADD COLUMN face_check TEXT CHECK (face_check IS NULL OR face_check IN ('none','detected','unchecked'));
                                                          -- people check: 'detected' and 'unchecked' are never published
ALTER TABLE reports ADD COLUMN media_removed TEXT;        -- JSON list of what was removed (e.g. "EXIF (camera, location, time)")
ALTER TABLE reports ADD COLUMN media_processed_at TEXT;
