// Dashboard send: validate, wrap the admin's plain text in the branded template, send through Resend, record in D1.
// Used by POST /api/admin/mail/send. env needs RESEND_API_KEY and DB. See docs/EMAIL-GUIDE.md.
import { TENANT } from "./tenant.generated.js";   // time zone per country (session 98)
import { MAILBOXES, fromHeader, validateSend, validateAttachments, textToHtml, replySubject } from "./mailbox.js";
import { general } from "./emails.js";
import { AUTO_REPLY_SENDER } from "./autoreply.js";

export const DAILY_LIMIT = 100;   // safety cap on dashboard sends per 24 hours (automatic replies have their own cap)
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lagos = (t) => new Date(t).toLocaleString("en-GB", { timeZone: TENANT.locale.timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " WAT";

/** @returns {{ status: number, body: object }} */
export async function sendFromDashboard(env, input, sender) {
  if (!env.RESEND_API_KEY || !env.DB) return { status: 503, body: { error: "Email sending is not configured." } };
  // Replying: thread under the original and quote it. The original must be an incoming message in our own table.
  let original = null;
  if (input?.replyToId) {
    original = await env.DB.prepare("SELECT id, from_addr, from_name, subject, body_text, message_id, at FROM mail_messages WHERE id = ?1 AND direction = 'in'").bind(String(input.replyToId)).first();
    if (!original) return { status: 404, body: { error: "The message you are replying to was not found." } };
  }
  const v = validateSend({ ...input, inReplyTo: original?.message_id ?? null, subject: input?.subject ?? (original ? replySubject(original.subject) : "") });
  const att = validateAttachments(input?.attachments);
  if (!v.ok || !att.ok) return { status: 422, body: { error: [...v.errors, ...att.errors].join("; ") } };
  const m = v.mail, box = MAILBOXES[m.from];
  const manifest = att.files.map(({ filename, contentType, size }) => ({ filename, mimeType: contentType, size }));
  const quoteHead = original ? `On ${lagos(original.at)}, ${original.from_name ? `${original.from_name} <${original.from_addr}>` : original.from_addr} wrote:` : null;
  const quoteText = original ? String(original.body_text ?? "").slice(0, 4000) : null;
  const mail = general({
    subject: m.subject, bodyHtml: textToHtml(m.body), signOff: box.name, from: box.address,
    quoted: original ? `${esc(quoteHead)}<br>${esc(quoteText).replace(/\n/g, "<br>")}` : null,
  });
  const text = `${m.body}\n\n${box.name}\nbinchika.com · ${box.address}${original ? `\n\n${quoteHead}\n${quoteText.split("\n").map((l) => `> ${l}`).join("\n")}` : ""}`;
  if (input?.dryRun) return { status: 200, body: { preview: mail.html, from: fromHeader(m.from), to: m.to, cc: m.cc, subject: m.subject, attachments: manifest } };   // "Preview" button: nothing sent or stored
  // Automatic replies and unsubscribe confirmations (session 96) have their own caps and do not use up this one.
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_messages WHERE direction = 'out' AND COALESCE(sent_by, '') NOT IN (?1, ?2) AND at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").bind(AUTO_REPLY_SENDER, "unsubscribe").first();
  if ((recent?.n ?? 0) >= DAILY_LIMIT) return { status: 429, body: { error: `Daily limit of ${DAILY_LIMIT} dashboard emails reached. Try again tomorrow.` } };
  const headers = m.inReplyTo ? { "In-Reply-To": m.inReplyTo, References: m.inReplyTo } : undefined;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: fromHeader(m.from), to: m.to, cc: m.cc.length ? m.cc : undefined, subject: m.subject, html: mail.html, text, headers,
      attachments: att.files.length ? att.files.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })) : undefined }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { status: 502, body: { error: `The email provider refused the message (${r.status}${j?.message ? `: ${String(j.message).slice(0, 160)}` : ""}). Nothing was sent.` } };
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO mail_messages (id, direction, mailbox, from_addr, from_name, to_addrs, cc_addrs, subject, body_text, body_html, in_reply_to, provider_id, sent_by, read_at, attachments)
    VALUES (?1, 'out', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?13)`).bind(
    id, m.from, box.address, box.name, JSON.stringify(m.to), JSON.stringify(m.cc), m.subject, text, mail.html, m.inReplyTo, j.id ?? null, sender ?? null, JSON.stringify(manifest),
  ).run();
  return { status: 200, body: { ok: true, id, providerId: j.id ?? null, from: box.address, to: m.to, attachments: manifest.length } };
}

/**
 * Delete one message from the dashboard (Inbox or Sent): the D1 row and, for incoming mail, the raw .eml in R2.
 * The copy already forwarded to EMAIL_FORWARD_TO is not touched. Used by DELETE /api/admin/mail/<id>.
 * @returns {{ status: number, body: object }}
 */
export async function deleteMail(env, id) {
  if (!env.DB) return { status: 503, body: { error: "mailbox not configured" } };
  const row = await env.DB.prepare("SELECT id, raw_key FROM mail_messages WHERE id = ?1").bind(String(id)).first();
  if (!row) return { status: 404, body: { error: "not found" } };
  if (row.raw_key && env.EVIDENCE) await env.EVIDENCE.delete(row.raw_key);
  await env.DB.prepare("DELETE FROM mail_messages WHERE id = ?1").bind(row.id).run();
  return { status: 200, body: { ok: true, deleted: row.id, rawDeleted: Boolean(row.raw_key && env.EVIDENCE) } };
}

export const MAIL_RETENTION_MIN_DAYS = 30;   // a lower or non-numeric setting is refused, so a typo can never empty the mailbox

/**
 * Retention: delete dashboard mail (Inbox and Sent, including automatic replies) older than `days`, with the raw .eml
 * of incoming messages in R2. Raw copies go first, so if anything fails the rows stay and are retried on the next run.
 * Run once a day by the mailbox Worker's cron (workers/mailbox, MAIL_RETENTION_DAYS). Copies already forwarded to
 * EMAIL_FORWARD_TO are not touched. See docs/EMAIL-GUIDE.md.
 * @returns {Promise<{ deleted: number, raw: number, skipped?: string }>}
 */
export async function purgeOldMail(env, days, { batch = 50, maxBatches = 20 } = {}) {
  const n = Number(String(days ?? "").trim());
  if (!Number.isInteger(n) || n < MAIL_RETENTION_MIN_DAYS) return { deleted: 0, raw: 0, skipped: `invalid retention "${String(days ?? "").slice(0, 20)}"` };
  if (!env.DB || !env.EVIDENCE) return { deleted: 0, raw: 0, skipped: "not configured" };
  let deleted = 0, raw = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { results } = await env.DB.prepare("SELECT id, raw_key FROM mail_messages WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?1) ORDER BY at LIMIT ?2").bind(`-${n} days`, batch).all();
    if (!results?.length) break;
    const keys = results.map((r) => r.raw_key).filter(Boolean);
    if (keys.length) await env.EVIDENCE.delete(keys);
    raw += keys.length;
    await env.DB.batch(results.map((r) => env.DB.prepare("DELETE FROM mail_messages WHERE id = ?1").bind(r.id)));
    deleted += results.length;
    if (results.length < batch) break;
  }
  return { deleted, raw };
}
