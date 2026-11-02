// GET /api/admin/mail?box=in|out&mailbox=all|ops|accounts|noreply&before=<ISO time> — BinchikAdmin + MFA only.
// Each Inbox row carries `optout` (session 96): an unsubscribe request and whether it has been handled.
// Lists the dashboard mailbox (Inbox: written by the Email Worker workers/mailbox; Sent: written by /api/admin/mail/send).
// No message bodies here; open one with GET /api/admin/mail/<id>. See docs/EMAIL-GUIDE.md.
import { requireAdmin, json } from "../../../_lib/supa.js";
import { MAILBOXES } from "../../../_lib/mailbox.js";
import { isOptOutRequest } from "../../../_lib/campaigns.js";

export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "mailbox not configured" }, 503);
  const u = new URL(request.url);
  const box = u.searchParams.get("box") === "out" ? "out" : "in";
  const mb = u.searchParams.get("mailbox");
  const before = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(u.searchParams.get("before") ?? "") ? u.searchParams.get("before") : "9999";
  const where = `m.direction = ?1 AND m.at < ?2${MAILBOXES[mb] ? " AND m.mailbox = ?3" : ""}`;
  const args = MAILBOXES[mb] ? [box, before, mb] : [box, before];
  // Session 96: opt_outs.mail_id links an opt-out to the Inbox message that asked for it (handled state for the chip).
  // If migration 0009 is not applied yet, the list works exactly as before (no opt-out state).
  const cols = `m.id, m.mailbox, m.from_addr, m.from_name, m.to_addrs, m.subject, substr(m.body_text, 1, 160) AS snippet, m.attachments, m.sent_by = 'auto-reply' AS auto, m.sent_by = 'unsubscribe' AS optout_confirm, m.at, m.read_at`;
  const { results } = await env.DB.prepare(`SELECT ${cols}, o.at AS optout_at, o.method AS optout_method FROM mail_messages m LEFT JOIN opt_outs o ON o.mail_id = m.id WHERE ${where} ORDER BY m.at DESC LIMIT 50`).bind(...args).all()
    .catch(() => env.DB.prepare(`SELECT ${cols} FROM mail_messages m WHERE ${where} ORDER BY m.at DESC LIMIT 50`).bind(...args).all());
  const unread = await env.DB.prepare("SELECT mailbox, COUNT(*) AS n FROM mail_messages WHERE direction = 'in' AND read_at IS NULL GROUP BY mailbox").all();
  return json({
    // optout: "done" when an opt-out was recorded for this message, "open" when it reads like one (unsubscribe, stop,
    // remove me as the subject or first line) but nothing was recorded yet. Incoming mail only.
    box, messages: (results ?? []).map(({ optout_at, optout_method, ...r }) => ({ ...r, to_addrs: JSON.parse(r.to_addrs ?? "[]"), attachments: JSON.parse(r.attachments ?? "[]").length,
      optout: box !== "in" ? null : optout_at ? { state: "done", at: optout_at, method: optout_method } : isOptOutRequest({ subject: r.subject, text: r.snippet }) ? { state: "open" } : null })),
    unread: Object.fromEntries((unread.results ?? []).map((r) => [r.mailbox ?? "other", r.n])),
    mailboxes: Object.entries(MAILBOXES).map(([key, m]) => ({ key, ...m })),
  });
}
