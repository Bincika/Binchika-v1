// Automatic reply for mail to ops@, accounts@ and noreply@binchika.com. Sent by the Email Worker (workers/mailbox) only
// after the message has been forwarded to the owner and/or stored for the Inbox, so it never replaces either.
// Pure decision and message builders, shared with tests. Rules follow RFC 3834: never answer automated, bulk, list or
// bounce mail, never our own domain, and at most one reply per sender per day (checked by the Worker). See docs/EMAIL-GUIDE.md.
import { MAILBOXES, fromHeader, replySubject, textToHtml } from "./mailbox.js";
import { general } from "./emails.js";
import { MEDIA_NATURE, mediaAutoReplyText } from "./media.js";

export const AUTO_REPLY_SENDER = "auto-reply";   // sent_by of the Sent rows the Worker records; not counted in DAILY_LIMIT
export const AUTO_REPLY_DAILY_LIMIT = 30;        // all senders together per 24 hours, so the Resend quota stays free for the dashboard
const OWN = /(^|\.)binchika\.com$/i;
const ROBOT = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|daemon|notifications?)([+._-]|$)|noreply/i;
const no = (reason) => ({ reply: false, reason });

/**
 * Should this incoming message get the automatic reply? Never throws.
 * @param {{ from: string, headers?: { get(name: string): string | null } }} m  envelope sender and message headers
 * @returns {{ reply: boolean, reason: string, to?: string }}
 */
export function autoReplyDecision({ from, headers }) {
  const addr = String(from ?? "").trim().toLowerCase();
  const h = (n) => String(headers?.get?.(n) ?? "");
  const [local, domain, extra] = addr.split("@");
  if (!local || !domain || extra !== undefined || !/^[^\s<>]+\.[a-z]{2,}$/.test(domain)) return no("no usable sender");
  if (OWN.test(domain)) return no("own domain");
  if (ROBOT.test(local)) return no("automated sender");
  if (h("auto-submitted") && !/^no\b/i.test(h("auto-submitted").trim())) return no("auto-submitted");
  if (/\b(bulk|list|junk|auto_reply)\b/i.test(h("precedence"))) return no("bulk or list");
  if (h("list-id") || h("list-unsubscribe") || h("list-post")) return no("mailing list");
  if (/\b(all|oof|autoreply)\b/i.test(h("x-auto-response-suppress"))) return no("suppression requested");
  if (h("x-autoreply") || h("x-autorespond")) return no("auto-reply");
  if (/multipart\/report/i.test(h("content-type"))) return no("delivery report");
  if (/\b(spf|dmarc)=fail\b/i.test(`${h("authentication-results")} ${h("arc-authentication-results")}`)) return no("failed authentication");
  if (/^\s*yes/i.test(h("x-spam-flag"))) return no("spam");
  return { reply: true, reason: "ok", to: addr };
}

/**
 * The reply itself: from noreply@, Reply-To the address they wrote to, threaded under their message, marked auto-replied.
 * Their message is not quoted (spam must not be echoed back). A contact-form enquiry also gets its ticket reference,
 * and a media access request (session 91) a paragraph on what happens next and the open press feed.
 * @param {{ mailbox?: string | null, subject?: string | null, messageId?: string | null, reference?: string | null, topic?: string | null }} m
 */
export function autoReplyMail({ mailbox, subject, messageId, reference = null, topic = null }) {
  const box = MAILBOXES[mailbox] ?? MAILBOXES.noreply;
  const clean = String(subject ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 150);
  const subj = clean ? replySubject(clean) : "We have received your message";
  const ref = /^BIN-\d{4}-\d{4,}$/.test(String(reference ?? "")) ? String(reference) : null;
  const body = `Thank you for contacting Binchika. This is an automatic reply to confirm that your message to ${box.address} has arrived.${ref ? `\n\nYour reference is ${ref}. Please keep it in the subject line if you write to us about this again.` : ""}${topic === MEDIA_NATURE ? `\n\n${mediaAutoReplyText()}` : ""}\n\nThe Binchika team will get in touch soon. There is no need to send your message again.`;
  const signOff = "The Binchika team";
  const mail = general({ subject: subj, bodyHtml: textToHtml(body), signOff, from: MAILBOXES.noreply.address, preheader: "Thank you. Your message has arrived." });
  const id = /^<[^\s<>]{3,250}>$/.test(String(messageId ?? "").trim()) ? String(messageId).trim() : null;
  return {
    from: fromHeader("noreply"), replyTo: box.address, subject: subj, html: mail.html,
    text: `${body}\n\n${signOff}\nbinchika.com · ${MAILBOXES.noreply.address}\n\nThis is an automatic reply. Binchika will never ask for payment, your password, BVN or bank details.`,
    headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All", ...(id ? { "In-Reply-To": id, References: id } : {}) },
    inReplyTo: id,
  };
}
