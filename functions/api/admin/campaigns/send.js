// POST /api/admin/campaigns/send { campaignId, from: "ops"|"accounts"|"noreply", subject, body, dryRun?, confirmCount }
// — BinchikAdmin + MFA only (session 96). dryRun returns the preview and the recipient count and sends nothing. A real
// send needs confirmCount equal to the current recipient count. Each person gets their own message with only their
// address in Bcc and their own unsubscribe link; the owner gets one blind copy (CAMPAIGN_OWNER_BCC). One Resend batch
// call per send, so it is all or nothing. Limits and rules: functions/_lib/campaigns.js. Guide: docs/EMAIL-GUIDE.md §5c.
import { requireAdmin, json } from "../../../_lib/supa.js";
import { methodNotAllowed } from "../../../_lib/http.js";
import { sendCampaign } from "../../../_lib/campaigns.js";

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return json({ error: "invalid JSON" }, 400);
  const r = await sendCampaign(env, b, gate.me.public_id);
  return json(r.body, r.status);
}

export const onRequestGet = () => methodNotAllowed("POST");
