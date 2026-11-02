-- Contact form rate limiting. Stores only a salted hash of the sender IP and the time; nothing else.
CREATE TABLE IF NOT EXISTS contact_log (
  ip_hash TEXT NOT NULL,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_contact_ip ON contact_log (ip_hash, at);
