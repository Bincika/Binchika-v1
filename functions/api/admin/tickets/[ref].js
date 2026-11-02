// POST /api/admin/tickets/<ref> { status?, resolution? } — BinchikAdmin + MFA only (session 78). Records who acted by
// public ID only. Statuses: new → in_progress → answered → closed (reopen by setting any open status again).
// Or { decision, note? } for a media access request (session 91): approved/declined → answered, more_info → in_progress.
import { requireAdmin, json } from "../../../_lib/supa.js";
import { updateTicket } from "../../../_lib/tickets.js";
import { decideMedia } from "../../../_lib/media.js";

export async function onRequestPost({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "tickets not configured" }, 503);
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return json({ error: "invalid JSON" }, 400);
  // Session 91: { decision: approved|more_info|declined, note? } records a media access decision (media tickets only).
  const r = b.decision !== undefined
    ? await decideMedia(env.DB, String(params.ref), { decision: b.decision, note: b.note }, gate.me.public_id, updateTicket)
    : await updateTicket(env.DB, String(params.ref), { status: b.status, resolution: b.resolution }, gate.me.public_id);
  return json(r.body, r.status);
}
