// GET /api/admin/contacts — the private contact registry (session 96): contacts with their campaign ids, campaigns with
// member counts, opt-outs (masked addresses) and the last 20 campaign sends (counts only). BinchikAdmin + MFA only.
// POST /api/admin/contacts { name, email, organisation?, notes? } adds one contact. An address that opted out is refused.
// Library and limits: functions/_lib/campaigns.js. Guide: docs/EMAIL-GUIDE.md §5c.
import { requireAdmin, json } from "../../../_lib/supa.js";
import { listRegistry, addContact, CAMPAIGN_MAX_RECIPIENTS, CAMPAIGN_DAILY_LIMIT } from "../../../_lib/campaigns.js";

export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "contacts not configured" }, 503);
  return json({ ...(await listRegistry(env)), limits: { perSend: CAMPAIGN_MAX_RECIPIENTS, perDay: CAMPAIGN_DAILY_LIMIT }, sendReady: Boolean(env.RESEND_API_KEY && env.UNSUBSCRIBE_KEY && env.CAMPAIGN_OWNER_BCC) });
}

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "contacts not configured" }, 503);
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return json({ error: "invalid JSON" }, 400);
  const r = await addContact(env, b, gate.me.public_id);
  return json(r.body, r.status);
}
