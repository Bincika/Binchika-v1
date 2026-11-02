// binchika-mailbox: Cloudflare Email Worker for accounts@, ops@ and noreply@binchika.com.
// 1. Forward to EMAIL_FORWARD_TO, exactly as plain Email Routing did, so the owner's inbox never misses a message.
// 2. Keep a copy for the BinchikAdmin dashboard: raw .eml in R2 (mail/raw/<id>.eml), parsed fields in D1 mail_messages.
// 3. Only then, send the sender one automatic reply from noreply@ (AUTO_REPLY="on"; functions/_lib/autoreply.js), recorded in Sent.
//    It never answers automated, bulk or list mail or our own domain, and at most once per sender per day.
// If both 1 and 2 fail, the message is rejected so the sender gets a bounce instead of silent loss (and gets no auto-reply).
// Session 96: our own campaign copies coming back to the From address (signed X-Binchika-Campaign marker) are accepted
// quietly before step 1: not forwarded, not stored, no reply. A reply that says UNSUBSCRIBE (or stop / remove me) as its
// subject or first line removes the sender from contacts and every campaign and gets the opt-out confirmation instead of
// the automatic reply (functions/_lib/campaigns.js). Steps 1 and 2 always run first for every other message.
// 4. Once a day (cron, see wrangler.toml), delete dashboard mail older than MAIL_RETENTION_DAYS, with its raw copies in R2.
//    The copies forwarded to EMAIL_FORWARD_TO are never touched by this.
// Logs carry no addresses or content.
import PostalMime from "postal-mime";
import { mailboxOf, htmlToText, MAILBOXES } from "../../../functions/_lib/mailbox.js";
import { autoReplyDecision, autoReplyMail, AUTO_REPLY_SENDER, AUTO_REPLY_DAILY_LIMIT } from "../../../functions/_lib/autoreply.js";
import { purgeOldMail } from "../../../functions/_lib/mailsend.js";
import { isCampaignLoopback, isOptOutRequest, optOut } from "../../../functions/_lib/campaigns.js";

const cap = (s, n) => (s == null ? null : String(s).slice(0, n));
const addrList = (xs) => (xs ?? []).flatMap((a) => (a.group ? a.group : [a])).map((a) => a.address).filter(Boolean);

export async function storeCopy(env, raw, envelopeTo) {
  const id = crypto.randomUUID();
  const key = `mail/raw/${id}.eml`;
  await env.EVIDENCE.put(key, raw, { httpMetadata: { contentType: "message/rfc822" } });
  const p = await PostalMime.parse(raw);
  const to = addrList(p.to), cc = addrList(p.cc);
  const html = cap(p.html, 200_000);
  const text = cap(p.text?.trim() ? p.text : htmlToText(p.html), 100_000) ?? "";
  await env.DB.prepare(`INSERT INTO mail_messages (id, direction, mailbox, from_addr, from_name, to_addrs, cc_addrs, subject, body_text, body_html, message_id, in_reply_to, attachments, raw_key)
    VALUES (?1, 'in', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`).bind(
    id, mailboxOf([envelopeTo, ...to, ...cc]), cap(p.from?.address ?? "unknown", 320), cap(p.from?.name, 200),
    JSON.stringify(to.length ? to : [envelopeTo]), JSON.stringify(cc), cap(p.subject ?? "", 500), text, html,
    cap(p.messageId, 300), cap(p.inReplyTo, 300),
    JSON.stringify((p.attachments ?? []).map((a) => ({ filename: cap(a.filename ?? "attachment", 200), mimeType: a.mimeType, size: a.content?.byteLength ?? 0 }))), key,
  ).run();
  return { id, attachments: p.attachments?.length ?? 0, from: cap(p.from?.address, 320), subject: p.subject ?? "", text };
}

/**
 * Session 96: an UNSUBSCRIBE reply. Acts only when the message passes the same checks as the automatic reply (no list,
 * bulk, robot or own-domain mail, no failed SPF/DMARC); otherwise it stays flagged in the Inbox for the BinchikAdmin.
 * Never throws. @returns {Promise<{ optOut: boolean, acted?: boolean, reason?: string }>} optOut true = skip the auto-reply.
 */
export async function optOutReply(env, message, stored) {
  try {
    if (!stored || !isOptOutRequest({ subject: stored.subject, text: stored.text })) return { optOut: false };
    const d = autoReplyDecision({ from: stored.from, headers: message.headers });
    if (!d.reply) return { optOut: true, acted: false, reason: d.reason };
    const r = await optOut(env, { email: stored.from, method: "reply", mailId: stored.id });
    return { optOut: true, acted: r.status === 200, reason: r.status === 200 ? (r.body.already ? "already" : "removed") : `status ${r.status}` };
  } catch (e) { return { optOut: true, acted: false, reason: `error: ${String(e).slice(0, 120)}` }; }
}

/** Send the automatic reply for one incoming message, if the rules allow it. Never throws. @returns {{ sent: boolean, reason: string }} */
export async function autoReply(env, message) {
  try {
    if (env.AUTO_REPLY !== "on") return { sent: false, reason: "switched off" };
    if (!env.RESEND_API_KEY || !env.DB) return { sent: false, reason: "not configured" };
    const d = autoReplyDecision({ from: message.from, headers: message.headers });
    if (!d.reply) return { sent: false, reason: d.reason };
    const to = JSON.stringify([d.to]);
    const recent = await env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(to_addrs = ?1), 0) AS same FROM mail_messages
      WHERE direction = 'out' AND sent_by = ?2 AND at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')`).bind(to, AUTO_REPLY_SENDER).first();
    if ((recent?.same ?? 0) > 0) return { sent: false, reason: "already replied today" };
    if ((recent?.total ?? 0) >= AUTO_REPLY_DAILY_LIMIT) return { sent: false, reason: "daily limit" };
    // message.reference: a contact-form ticket reference (session 78, /api/contact); incoming email has none.
    // message.topic: the contact-form topic (session 91); a media access request gets its own paragraph. Email has none.
    const m = autoReplyMail({ mailbox: mailboxOf(message.to), subject: message.headers?.get("subject"), messageId: message.headers?.get("message-id"), reference: message.reference, topic: message.topic });
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: m.from, to: [d.to], reply_to: m.replyTo, subject: m.subject, html: m.html, text: m.text, headers: m.headers }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { sent: false, reason: `provider ${r.status}` };
    await env.DB.prepare(`INSERT INTO mail_messages (id, direction, mailbox, from_addr, from_name, to_addrs, cc_addrs, subject, body_text, body_html, in_reply_to, provider_id, sent_by, read_at, attachments)
      VALUES (?1, 'out', 'noreply', ?2, ?3, ?4, '[]', ?5, ?6, ?7, ?8, ?9, ?10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), '[]')`).bind(
      crypto.randomUUID(), MAILBOXES.noreply.address, MAILBOXES.noreply.name, to, m.subject, m.text, m.html, m.inReplyTo, j.id ?? null, AUTO_REPLY_SENDER,
    ).run();
    return { sent: true, reason: "ok" };
  } catch (e) { return { sent: false, reason: `error: ${String(e).slice(0, 120)}` }; }
}

export default {
  async email(message, env, ctx) {
    if (await isCampaignLoopback(env, message.headers?.get("from"), message.headers)) return console.log(JSON.stringify({ event: "mailbox-campaign-copy-skipped" }));
    const raw = await new Response(message.raw).arrayBuffer();
    let forwarded = false, stored = false, copy = null;
    if (env.EMAIL_FORWARD_TO) {
      try { await message.forward(env.EMAIL_FORWARD_TO); forwarded = true; } catch (e) { console.log(JSON.stringify({ event: "mailbox-forward-failed", error: String(e).slice(0, 160) })); }
    }
    try {
      const r = await storeCopy(env, raw, message.to);
      stored = true; copy = r;
      console.log(JSON.stringify({ event: "mailbox-stored", id: r.id, mailbox: mailboxOf(message.to), bytes: raw.byteLength, attachments: r.attachments, forwarded }));
    } catch (e) { console.log(JSON.stringify({ event: "mailbox-store-failed", error: String(e).slice(0, 160), forwarded })); }
    if (!forwarded && !stored) { message.setReject("Temporary problem delivering to binchika.com. Please try again later."); return; }
    const o = await optOutReply(env, message, copy);
    if (o.optOut) return console.log(JSON.stringify({ event: "mailbox-optout", acted: o.acted, reason: o.reason }));
    const a = await autoReply(env, message);
    console.log(JSON.stringify({ event: "mailbox-autoreply", sent: a.sent, reason: a.reason }));
  },
  // Daily retention run. MAIL_RETENTION_DAYS = "off" stops it; any value that is not a whole number of at least 30 days is refused.
  async scheduled(controller, env) {
    const days = String(env.MAIL_RETENTION_DAYS ?? "").trim();
    if (days.toLowerCase() === "off") return console.log(JSON.stringify({ event: "mailbox-retention", skipped: "switched off" }));
    try {
      console.log(JSON.stringify({ event: "mailbox-retention", days, ...(await purgeOldMail(env, days)) }));
    } catch (e) { console.log(JSON.stringify({ event: "mailbox-retention-failed", error: String(e).slice(0, 160) })); }
  },
  async fetch() { return new Response("binchika mailbox worker", { status: 404 }); },
};
