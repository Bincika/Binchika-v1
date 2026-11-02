// GET /api/admin/tickets?status=new|in_progress|answered|closed — BinchikAdmin + MFA only (session 78, phase 1, no AI).
// Contact-form tickets: reference, topic, mailbox, status and dates. No personal data here; open the message with
// GET /api/admin/mail/<mail_id>. Design: docs/TICKETED-INQUIRIES-DESIGN.md.
// Session 80 (knowledge base K1): each open ticket may carry a suggested approved answer, matched here on the server from
// the Inbox message with plain word rules (functions/_lib/kb.js). Only the answer, its score and the matched words are
// returned, never the message. A person checks and sends it ("Reply with this"); nothing is sent automatically.
// Session 91: media access requests (topic media_access) carry a "media" object instead: see functions/_lib/media.js.
import { requireAdmin, json } from "../../../_lib/supa.js";
import { listTickets } from "../../../_lib/tickets.js";
import { NATURES } from "../../../_lib/contact.js";
import { matchKb, enquiryText, replyText } from "../../../_lib/kb.js";
import { KB } from "../../../_lib/kb.generated.js";
import { MEDIA_NATURE, MEDIA_DECISIONS, MEDIA_DECLINE_REASONS, mediaChecks, mediaDecisionOf, mediaReply } from "../../../_lib/media.js";

export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "tickets not configured" }, 503);
  const status = new URL(request.url).searchParams.get("status");
  const r = await listTickets(env.DB, { status });
  const open = r.tickets.filter((t) => t.mail_id && t.status !== "closed");
  const mails = open.length
    ? (await env.DB.prepare(`SELECT id, subject, body_text FROM mail_messages WHERE id IN (${open.map((_, i) => `?${i + 1}`).join(",")})`).bind(...open.map((t) => t.mail_id)).all()).results ?? []
    : [];
  const byId = new Map(mails.map((m) => [m.id, m]));
  return json({
    ...r,
    tickets: r.tickets.map((t) => {
      const m = t.status !== "closed" && byId.get(t.mail_id);
      // Session 91: a media access request gets its review checklist (booleans read from the stored text, never the
      // organisation or the sender), the decision already recorded, and draft replies. No KB suggestion for these.
      if (t.nature === MEDIA_NATURE) {
        return { ...t, topic: NATURES[t.nature].label, kb: null, media: {
          decision: mediaDecisionOf(t.resolution), ...(m ? mediaChecks(m.body_text) : {}),
          replies: Object.fromEntries(Object.keys(MEDIA_DECISIONS).map((d) => [d, mediaReply(d, t.ref)])),
          // Session 92: one decline draft per neutral reason; the reviewer picks the reason in the Tickets view.
          declines: Object.fromEntries(Object.entries(MEDIA_DECLINE_REASONS).map(([k, r]) => [k, { label: r.label, reply: mediaReply("declined", t.ref, k) }])),
        } };
      }
      const best = m ? matchKb(KB, { nature: t.nature, text: enquiryText(m.subject, m.body_text) })[0] : null;
      const entry = best && KB.find((e) => e.id === best.id);
      return { ...t, topic: NATURES[t.nature]?.label ?? t.nature, kb: entry ? { ...best, link: entry.link, reply: replyText(entry, t.ref) } : null };
    }),
  });
}
