// Contact-form enquiries in the dashboard Inbox (session 77). The form delivers to EMAIL_FORWARD_TO through Resend,
// which never passes through binchika.com Email Routing, so the mailbox Worker never saw it: no Inbox copy and no
// automatic reply. /api/contact now builds a standard .eml of the enquiry (this file), stores it with the Worker's own
// storeCopy() (R2 raw + D1 mail_messages, so the viewer and attachment download work unchanged), and sends the Worker's
// own autoReply(). Pure builders, shared with tests.
import { MAILBOXES } from "./mailbox.js";
import { NATURES } from "./contact.js";

/** Which dashboard mailbox an enquiry of this nature belongs to (the address the form sends it from). */
export function mailboxForNature(nature) {
  const from = String(NATURES[nature]?.from ?? "");
  return Object.keys(MAILBOXES).find((k) => from.includes(`<${MAILBOXES[k].address}>`)) ?? "noreply";
}

const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const wrap = (s) => s.replace(/.{1,76}/g, "$&\r\n");
// RFC 2047 encoded word for headers that may carry non-ASCII; plain ASCII passes through (quotes and CR/LF removed).
const word = (s) => {
  const clean = String(s ?? "").replace(/[\r\n"]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(new TextEncoder().encode(clean))}?=`;
};
const safeAddr = (a) => String(a ?? "").replace(/[\r\n<>"\s]+/g, "");

/**
 * The enquiry as an RFC 5322 message, addressed from the requester to the Binchika mailbox it belongs to.
 * @param {{ mailbox: string, name?: string, email: string, subject: string, text: string, messageId: string, date?: Date,
 *           files?: { filename: string, type: string, bytes: Uint8Array }[] }} m
 * @returns {Uint8Array}
 */
export function contactEml({ mailbox, name, email, subject, text, messageId, date = new Date(), files = [] }) {
  const box = MAILBOXES[mailbox] ?? MAILBOXES.noreply;
  const boundary = `binchika-${crypto.randomUUID()}`;
  const from = name ? `"${word(name)}" <${safeAddr(email)}>` : `<${safeAddr(email)}>`;
  const head = [
    `From: ${from}`, `Reply-To: <${safeAddr(email)}>`, `To: ${box.name} <${box.address}>`, `Subject: ${word(subject)}`,
    `Date: ${date.toUTCString()}`, `Message-ID: ${messageId}`, "MIME-Version: 1.0", "X-Binchika-Source: contact-form",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap(b64(new TextEncoder().encode(text)))].join("\r\n"),
    ...files.map((f) => {
      const fname = String(f.filename ?? "attachment").replace(/[\r\n"]+/g, "_").slice(0, 120);
      return [`--${boundary}`, `Content-Type: ${String(f.type || "application/octet-stream").replace(/[\r\n;]+/g, "")}; name="${word(fname)}"`,
        "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(fname)}`, "", wrap(b64(f.bytes))].join("\r\n");
    }),
  ];
  return new TextEncoder().encode(`${head.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`);
}
