// POST /api/portal/evidence {reportId, decision: "approved"|"rejected", note} — a signed-in SZV or NRV audits one piece
// of alternative evidence (no Form EC8A) from their own state or region. Lower-confidence by design; see
// functions/_lib/evidence.js and docs/EVIDENCE-AUDIT.md. Reporter identities are never returned.
import { userFromRequest, verifierFor, rest, supaConfigured, json } from "../../_lib/supa.js";
import { auditEvidence } from "../../_lib/evidence.js";

export async function onRequestPost({ request, env }) {
  if (!supaConfigured(env) || !env.DB) return json({ error: "verifier system not configured" }, 503);
  const user = await userFromRequest(request, env);
  if (!user) return json({ error: "sign in required" }, 401);
  const me = await verifierFor(env, user.id);
  if (!me) return json({ error: "not a verifier" }, 403);
  const states = me.role === "szv" ? [me.state_iso]
    : me.role === "nrv" ? (await rest(env, `region_states?region_id=eq.${encodeURIComponent(me.region_id)}&select=state_iso`)).map((r) => r.state_iso)
    : [];
  const body = await request.json().catch(() => ({}));
  const r = await auditEvidence(env.DB, body, { role: me.role, public_id: me.public_id, states });
  return json(r.body, r.status);
}
