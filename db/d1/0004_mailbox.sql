-- Dashboard mailbox (Inbox & Sent), BinchikAdmin only. Incoming rows are written by the Email Worker
-- workers/mailbox (after it has forwarded the message to EMAIL_FORWARD_TO); outgoing rows by /api/admin/mail/send.
-- The raw incoming message (.eml, with any attachments) is kept in R2 under mail/raw/<id>.eml. See docs/EMAIL-GUIDE.md.
CREATE TABLE IF NOT EXISTS mail_messages (
  id           TEXT PRIMARY KEY,                       -- random UUID
  direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  mailbox      TEXT,                                   -- ops | accounts | noreply (which of our addresses)
  from_addr    TEXT NOT NULL,
  from_name    TEXT,
  to_addrs     TEXT NOT NULL,                          -- JSON array
  cc_addrs     TEXT,                                   -- JSON array
  subject      TEXT NOT NULL DEFAULT '',
  body_text    TEXT NOT NULL DEFAULT '',               -- capped at 100 kB
  body_html    TEXT,                                   -- capped at 200 kB; shown only in a sandboxed frame
  message_id   TEXT,                                   -- the Message-ID header (used for reply threading)
  in_reply_to  TEXT,
  attachments  TEXT,                                   -- JSON [{ filename, mimeType, size }]
  raw_key      TEXT,                                   -- R2 key of the raw message (incoming only)
  provider_id  TEXT,                                   -- Resend email id (outgoing only)
  sent_by      TEXT,                                   -- public ID of the sender (outgoing only, e.g. V0001)
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_dir_at ON mail_messages (direction, at DESC);
