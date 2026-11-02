-- Ticketed enquiries, phase 1 (session 78; docs/TICKETED-INQUIRIES-DESIGN.md). No AI. Every contact-form enquiry gets a
-- reference BIN-YYMM-NNNN (month in Lagos time, counter restarts monthly). A ticket holds no personal data: the
-- requester's name, address and message stay in mail_messages (BinchikAdmin only, 365-day retention), and the ticket is
-- deleted with its Inbox message (ON DELETE CASCADE; D1 enforces foreign keys).
CREATE TABLE IF NOT EXISTS ticket_counters (
  yymm TEXT PRIMARY KEY,                               -- e.g. 2611
  n    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  ref        TEXT PRIMARY KEY,                         -- BIN-2611-0042
  mail_id    TEXT REFERENCES mail_messages(id) ON DELETE CASCADE,   -- the Inbox copy (NULL only if storing it failed)
  nature     TEXT NOT NULL,                            -- contact-form topic key (functions/_lib/contact.js NATURES)
  mailbox    TEXT NOT NULL,                            -- ops | accounts | noreply
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'answered', 'closed')),
  owner_seat TEXT,                                     -- public ID of the seat handling it (e.g. V0001), never a name
  resolution TEXT,                                     -- short note, no personal data (max 500 characters, checked by the API)
  due_at     TEXT NOT NULL,                            -- two working days after creation (Lagos time)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_status_due ON tickets (status, due_at);
CREATE INDEX IF NOT EXISTS idx_tickets_mail ON tickets (mail_id);
