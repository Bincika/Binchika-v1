// POST /api/contact (multipart/form-data) — delivers to the owner's inbox via Resend.
// FROM address matches the purpose (accounts@ / ops@ / noreply@); reply-to is the sender.
// Session 77: after that delivery, the enquiry is also stored in the dashboard Inbox and the sender gets the branded
// automatic reply from noreply@, with the mailbox Worker's own storeCopy() and autoReply() (functions/_lib/contactmail.js).
// Neither step can undo or block the delivery to EMAIL_FORWARD_TO; failures are logged without addresses or content.
import { TENANT } from "../_lib/tenant.generated.js";   // time zone per country (session 98)
import { validateContact, subjectFor, NATURES } from "../_lib/contact.js";
import { contactEml, mailboxForNature } from "../_lib/contactmail.js";
import { MAILBOXES } from "../_lib/mailbox.js";
import { storeCopy, autoReply } from "../../workers/mailbox/src/index.js";
import { nextRef, openTicket } from "../_lib/tickets.js";
import { MEDIA_NATURE, validateMedia, mediaBlock, mediaAutoChecks } from "../_lib/media.js";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const b64 = (buf) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

export async function onRequestPost({ request, env }) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FORWARD_TO) return json({ error: "The contact form is not configured yet." }, 503);
  if (Number(request.headers.get("content-length") ?? 0) > 12 * 1024 * 1024) return json({ error: "Too large." }, 413);
  let form;
  try { form = await request.formData(); } catch { return json({ error: "Invalid form." }, 400); }
  const files = form.getAll("files").filter((f) => typeof f === "object" && f.size > 0);
  const f = {
    nature: form.get("nature"), name: String(form.get("name") ?? "").replace(/[\r\n\t]+/g, " ").trim(), email: String(form.get("email") ?? "").trim(),
    message: String(form.get("message") ?? ""), website: form.get("website"), renderedAt: form.get("renderedAt"),
    party: String(form.get("party") ?? "").slice(0, 12), files: files.map((x) => ({ name: x.name, type: x.type, size: x.size })),
  };
  const v = validateContact(f);
  if (!v.ok) return json({ error: v.errors.includes("spam") || v.errors.includes("too fast") ? "Please try again." : v.errors.join("; ") }, 422);
  // Session 91: a media access request carries a few more fields. They go into the enquiry text only (the owner copy and
  // the Inbox copy), never into a new table.
  let media = null;
  if (f.nature === MEDIA_NATURE) {
    const mv = validateMedia({ org: form.get("org"), orgUrl: form.get("org_url"), orgType: form.get("org_type"), use: form.get("use"), polling: form.get("polling"), terms: form.get("terms"), regNo: form.get("reg_no"), techEmail: form.get("tech_email") });
    if (!mv.ok) return json({ error: mv.errors.join("; ") }, 422);
    // Session 92: DNS checks through a fixed public resolver (never the requester's own address); at most 2.5 s, never blocking.
    media = mediaBlock(mv.value, f.email, await mediaAutoChecks(mv.value, f.email));
  }

  // rate limit: 5 per hour per salted IP hash
  if (env.DB) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.REPORTER_HASH_SALT ?? ""}:contact:${ip}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM contact_log WHERE ip_hash = ?1 AND at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").bind(h).first();
    if ((recent?.n ?? 0) >= 5) return json({ error: "Too many messages from this connection. Please try again later." }, 429);
    await env.DB.prepare("INSERT INTO contact_log (ip_hash) VALUES (?1)").bind(h).run();
  }

  // Ticket reference (session 78): reserved before the owner copy so it is in every copy. If the counter fails, the
  // enquiry still goes through without one.
  let ref = null;
  if (env.DB) { try { ref = await nextRef(env.DB); } catch (e) { console.log(JSON.stringify({ event: "contact-ref-failed", error: String(e).slice(0, 160) })); } }

  const bytes = await Promise.all(files.map(async (x) => new Uint8Array(await x.arrayBuffer())));
  const attachments = files.map((x, i) => ({ filename: x.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120), content: b64(bytes[i]) }));
  const text = [
    ref ? `Reference: ${ref}` : null, `Nature: ${NATURES[f.nature].label}`, f.party ? `Party: ${f.party}` : null,
    `From: ${f.name || "(no name given)"} <${f.email}>`, `Sent: ${new Date().toLocaleString("en-GB", { timeZone: TENANT.locale.timeZone })} WAT`,
    `Attachments: ${attachments.length}`, ...(media ? ["", ...media] : []), "", f.message.trim(), "", "— Sent via the contact form at binchika.com/contact/",
  ].filter((l) => l !== null).join("\n");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: NATURES[f.nature].from, to: [env.EMAIL_FORWARD_TO], reply_to: f.email, subject: subjectFor(f, ref), text, attachments }),
  });
  if (!r.ok) return json({ error: "Your message could not be sent right now. Please try again shortly." }, 502);

  // Dashboard Inbox copy, then the automatic reply (the same rules as mail sent straight to the mailboxes).
  const mailbox = mailboxForNature(f.nature);
  const to = MAILBOXES[mailbox].address;
  const subject = subjectFor(f, ref);
  const messageId = `<contact-${crypto.randomUUID()}@binchika.com>`;
  let stored = null;
  if (env.DB && env.EVIDENCE) {
    try {
      const raw = contactEml({ mailbox, name: f.name, email: f.email, subject, text, messageId,
        files: files.map((x, i) => ({ filename: attachments[i].filename, type: x.type, bytes: bytes[i] })) });
      stored = await storeCopy(env, raw, to);
    } catch (e) { console.log(JSON.stringify({ event: "contact-store-failed", error: String(e).slice(0, 160) })); }
  }
  if (ref) {
    try { await openTicket(env.DB, { ref, mailId: stored?.id ?? null, nature: f.nature, mailbox }); }
    catch (e) { console.log(JSON.stringify({ event: "contact-ticket-failed", error: String(e).slice(0, 160) })); }
  }
  // A plain lookup, not new Headers(): Headers only accepts Latin-1, and subjects carry "…", "·" and the sender's own words.
  const hdr = { subject, "message-id": messageId };
  const reply = await autoReply(env, { from: f.email, to, reference: ref, topic: f.nature, headers: { get: (n) => hdr[String(n).toLowerCase()] ?? null } });
  console.log(JSON.stringify({ event: "contact-delivered", mailbox, ticket: Boolean(ref), stored: Boolean(stored), autoReply: reply.sent, reason: reply.reason }));
  return json({ ok: true, reference: ref });
}
