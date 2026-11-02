// POST /api/admin/revoke { offerId } — BinchikAdmin + MFA only. Revokes an unclaimed invite code of any kind;
// the applicant becomes eligible again. A claimed seat is released with /api/admin/release instead.
import { requireAdmin, json } from "../../_lib/supa.js";
import { revokeInvite, dbMessage } from "../../_lib/invites.js";

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!/^[0-9a-f-]{36}$/.test(b?.offerId ?? "")) return json({ error: "offerId is required" }, 422);
  try {
    return json(await revokeInvite(env, { offerId: b.offerId, actorUserId: gate.user.id }));
  } catch (e) {
    return json({ error: dbMessage(e) }, 409);
  }
}
