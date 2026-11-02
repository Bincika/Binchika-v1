// POST /api/admin/mail/send { from: "ops"|"accounts"|"noreply", to, cc?, subject, body, replyToId?, attachments?: [{ filename,
// contentType, content (base64) }], dryRun? } — BinchikAdmin + MFA only. Limits in functions/_lib/mailbox.js.
// Sends the admin's plain text inside the branded template (functions/_lib/emails.js general()) through Resend, and
// records it for the Sent view. The "From" choices live in functions/_lib/mailbox.js (MAILBOXES).
import { requireAdmin, json } from "../../../_lib/supa.js";
import { sendFromDashboard } from "../../../_lib/mailsend.js";

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const r = await sendFromDashboard(env, b, gate.me.public_id);
  return json(r.body, r.status);
}
