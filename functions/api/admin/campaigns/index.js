// POST /api/admin/campaigns { name } creates a named campaign (session 96). BinchikAdmin + MFA only. The list comes with
// GET /api/admin/contacts. functions/_lib/campaigns.js
import { requireAdmin, json } from "../../../_lib/supa.js";
import { methodNotAllowed } from "../../../_lib/http.js";
import { createCampaign } from "../../../_lib/campaigns.js";

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "contacts not configured" }, 503);
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return json({ error: "invalid JSON" }, 400);
  const r = await createCampaign(env, b.name, gate.me.public_id);
  return json(r.body, r.status);
}

export const onRequestGet = () => methodNotAllowed("POST");
