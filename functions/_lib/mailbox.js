// Dashboard mailbox (Inbox & Sent): the "From" addresses, send validation and text helpers. Pure; shared by the
// Pages Functions (/api/admin/mail*), the Email Worker (workers/mailbox) and tests. See docs/EMAIL-GUIDE.md.

// The only addresses the dashboard may send from. To add one: add it here, add a Cloudflare Email Routing rule for it
// (scripts/mailbox-routing.mjs), and it works with Resend because the whole binchika.com domain is verified there.
export const MAILBOXES = {
  ops: { address: "ops@binchika.com", name: "Binchika Ops", purpose: "verifiers, maintenance, technical and operational" },
  accounts: { address: "accounts@binchika.com", name: "Binchika Accounts", purpose: "parties, manifestos, data requests" },
  noreply: { address: "noreply@binchika.com", name: "Binchika", purpose: "announcements and notices (replies still arrive)" },
};
export const fromHeader = (key) => `${MAILBOXES[key].name} <${MAILBOXES[key].address}>`;

export const MAX_RECIPIENTS = 10;
const EMAIL = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,255}\.[a-z]{2,}$/i;
export const splitAddrs = (s) => String(s ?? "").split(/[,;\n]+/).map((x) => x.trim().replace(/^.*<([^>]+)>\s*$/, "$1")).filter(Boolean);

/** @param {{from, to, cc, subject, body, inReplyTo}} b  → { ok, errors, mail } with normalised fields. */
export function validateSend(b) {
  const errors = [];
  const from = String(b?.from ?? "");
  if (!MAILBOXES[from]) errors.push(`"From" must be one of: ${Object.values(MAILBOXES).map((m) => m.address).join(", ")}`);
  const to = splitAddrs(b?.to), cc = splitAddrs(b?.cc);
  if (!to.length) errors.push("add at least one recipient");
  if (to.length + cc.length > MAX_RECIPIENTS) errors.push(`at most ${MAX_RECIPIENTS} recipients in total`);
  for (const a of [...to, ...cc]) if (!EMAIL.test(a)) errors.push(`not an email address: ${a.slice(0, 80)}`);
  const subject = String(b?.subject ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!subject || subject.length > 200) errors.push("subject must be 1–200 characters");
  const body = String(b?.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!body || body.length > 20000) errors.push("message must be 1–20,000 characters");
  const inReplyTo = /^<[^\s<>]{3,250}>$/.test(String(b?.inReplyTo ?? "")) ? b.inReplyTo : null;
  return { ok: errors.length === 0, errors, mail: { from, to, cc, subject, body, inReplyTo } };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** Plain text → email-safe HTML paragraphs: blank line = new paragraph, single newline = line break, https links clickable. */
export function textToHtml(text) {
  const link = (s) => s.replace(/https:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g, (u) => `<a href="${u}" style="color:#983F14">${u}</a>`);
  return String(text ?? "").trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${link(esc(p)).replace(/\n/g, "<br>")}</p>`).join("");
}

/** Rough HTML → text for incoming mail that has no plain-text part. Display only; never rendered as HTML. */
export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Which of our mailboxes an incoming message was addressed to (first match), or null. */
export function mailboxOf(addrs) {
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => String(a ?? "").toLowerCase());
  return Object.keys(MAILBOXES).find((k) => list.includes(MAILBOXES[k].address)) ?? null;
}

/** "Re: " once, never "Re: Re: ". */
export const replySubject = (s) => (/^\s*re:/i.test(s ?? "") ? String(s) : `Re: ${s ?? ""}`).slice(0, 200);

// Attachments on dashboard sends (Compose / Reply). The browser compresses images before upload (portal.js);
// documents (PDF, Office) are already compressed formats and go as they are. Content arrives as base64.
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACH_BYTES = 15 * 1024 * 1024;   // decoded total; Resend allows 40 MB per email including base64
export const ATTACH_TYPES = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|text\/(plain|csv)|application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint)|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))$/;
const b64bytes = (s) => { const t = String(s ?? ""); return Math.floor((t.length * 3) / 4) - (t.endsWith("==") ? 2 : t.endsWith("=") ? 1 : 0); };
export const safeFilename = (n) => String(n ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "attachment";

/** @param {{filename, contentType, content}[]} list  → { ok, errors, files: [{ filename, contentType, content, size }] } */
export function validateAttachments(list) {
  const errors = [], files = [];
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > MAX_ATTACHMENTS) errors.push(`at most ${MAX_ATTACHMENTS} attachments`);
  let total = 0;
  for (const a of arr.slice(0, MAX_ATTACHMENTS)) {
    const filename = safeFilename(a?.filename), contentType = String(a?.contentType ?? "").toLowerCase(), content = String(a?.content ?? "");
    if (!ATTACH_TYPES.test(contentType)) { errors.push(`file type not accepted: ${filename}`); continue; }
    if (!content || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) { errors.push(`file could not be read: ${filename}`); continue; }
    const size = b64bytes(content);
    total += size;
    files.push({ filename, contentType, content, size });
  }
  if (total > MAX_ATTACH_BYTES) errors.push(`attachments are ${(total / 1048576).toFixed(1)} MB after compression; the limit is ${MAX_ATTACH_BYTES / 1048576} MB`);
  return { ok: errors.length === 0, errors, files };
}
