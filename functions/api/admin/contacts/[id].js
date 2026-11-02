// POST /api/admin/contacts/<id> { name, email, organisation?, notes? } edits a contact; DELETE removes it (its campaign
// memberships go with it). BinchikAdmin + MFA only (session 96). functions/_lib/campaigns.js
import { requireAdmin, json } from "../../../_lib/supa.js";
import { methodNotAllowed } from "../../../_lib/http.js";
import { updateContact, removeContact } from "../../../_lib/campaigns.js";

export async function onRequestPost({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "contacts not configured" }, 503);
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return json({ error: "invalid JSON" }, 400);
  const r = await updateContact(env, String(params.id), b);
  return json(r.body, r.status);
}

export async function onRequestDelete({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "contacts not configured" }, 503);
  const r = await removeContact(env, String(params.id));
  return json(r.body, r.status);
}

export const onRequestGet = () => methodNotAllowed("POST, DELETE");
