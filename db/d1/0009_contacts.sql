-- Contacts, campaigns and opt-outs (session 96; docs/egm/admin-contacts/build-plan.md). BinchikAdmin + MFA only, through
-- /api/admin/contacts* and /api/admin/campaigns*; nothing here is public. Additive: no existing table is changed.
-- A person who unsubscribes is deleted from contacts (their campaign links cascade) and kept only in opt_outs as a hash
-- and a masked address, so they cannot be added again by mistake. See docs/EMAIL-GUIDE.md §5c.
CREATE TABLE IF NOT EXISTS contacts (
  id           TEXT PRIMARY KEY,                       -- random UUID
  name         TEXT NOT NULL,                          -- max 120 characters (checked by the API)
  email        TEXT NOT NULL UNIQUE COLLATE NOCASE,    -- stored lower-case
  organisation TEXT,                                   -- optional, max 160
  notes        TEXT,                                   -- optional, max 1000; private to the BinchikAdmin
  created_by   TEXT,                                   -- public ID of the seat that added it (e.g. V0001), never a name
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,      -- max 80
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS campaign_members (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_members_contact ON campaign_members (contact_id);
-- One row per campaign send. No recipient addresses: counts only.
CREATE TABLE IF NOT EXISTS campaign_sends (
  id            TEXT PRIMARY KEY,                      -- also sent as the X-Binchika-Campaign header (loop-back copies are skipped)
  campaign_id   TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_name TEXT NOT NULL,
  mailbox       TEXT NOT NULL,                         -- ops | accounts | noreply (the From address)
  subject       TEXT NOT NULL,
  body_text     TEXT NOT NULL,
  recipients    INTEGER NOT NULL,                      -- members at the time of sending
  accepted      INTEGER NOT NULL DEFAULT 0,            -- messages the provider accepted
  failed        INTEGER NOT NULL DEFAULT 0,
  owner_copy    INTEGER NOT NULL DEFAULT 0,            -- 1 once the owner's blind copy was accepted
  status        TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'partial', 'failed')),
  sent_by       TEXT,
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sends_at ON campaign_sends (at DESC);
CREATE TABLE IF NOT EXISTS opt_outs (
  id            TEXT PRIMARY KEY,
  email_sha256  TEXT NOT NULL UNIQUE,                  -- SHA-256 of the lower-case address
  email_masked  TEXT NOT NULL,                         -- e.g. j***@example.org (for the dashboard)
  method        TEXT NOT NULL CHECK (method IN ('link', 'reply', 'admin')),
  campaigns     TEXT,                                  -- names of the campaigns they were in (JSON array)
  mail_id       TEXT,                                  -- Inbox message that asked (reply / admin); no foreign key: retention may delete it
  confirmed     INTEGER NOT NULL DEFAULT 0,            -- 1 once the confirmation email was accepted
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_optouts_mail ON opt_outs (mail_id);
