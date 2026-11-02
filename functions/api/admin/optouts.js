// POST /api/admin/optouts { mailId } — BinchikAdmin + MFA only (session 96). Acts on an opt-out request in the Inbox:
// the sender of that incoming message is removed from contacts and every campaign, the opt-out is recorded, and the
// automated confirmation goes from noreply@ (once). Used when the mailbox Worker did not act by itself (for example the
// message failed its authenticity checks). functions/_lib/campaigns.js optOut()
import { requireAdmin, json } from "../../_lib/supa.js";
import { methodNotAllowed } from "../../_lib/http.js";
import { optOut } from "../../_lib/campaigns.js";

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "mailbox not configured" }, 503);
  const b = await request.json().catch(() => null);
  const m = await env.DB.prepare("SELECT id, from_addr FROM mail_messages WHERE id = ?1 AND direction = 'in'").bind(String(b?.mailId ?? "")).first();
  if (!m) return json({ error: "The message was not found." }, 404);
  const r = await optOut(env, { email: m.from_addr, method: "admin", mailId: m.id });
  return json(r.body, r.status);
}

export const onRequestGet = () => methodNotAllowed("POST");
