// POST /api/admin/campaigns/<id> { name?, add?: [contact id], remove?: [contact id] } renames a campaign and/or changes its
// members; DELETE removes the campaign (contacts stay; the send log keeps its name). BinchikAdmin + MFA only (session 96).
// The static route /api/admin/campaigns/send is matched before this one; campaign ids are UUIDs.
import { requireAdmin, json } from "../../../_lib/supa.js";
import { methodNotAllowed } from "../../../_lib/http.js";
import { updateCampaign, deleteCampaign } from "../../../_lib/campaigns.js";

export async function onRequestPost({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "contacts not configured" }, 503);
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return json({ error: "invalid JSON" }, 400);
  const r = await updateCampaign(env, String(params.id), b);
  return json(r.body, r.status);
}

export async function onRequestDelete({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "contacts not configured" }, 503);
  const r = await deleteCampaign(env, String(params.id));
  return json(r.body, r.status);
}

export const onRequestGet = () => methodNotAllowed("POST, DELETE");
