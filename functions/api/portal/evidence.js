// POST /api/portal/evidence {reportId, decision: "approved"|"rejected", note} — a signed-in SZV or NRV audits one piece
// of alternative evidence (no Form R1) from their own state or region. Lower-confidence by design; see
// functions/_lib/evidence.js and docs/EVIDENCE-AUDIT.md. Reporter identities are never returned.
import { userFromRequest, verifierFor, rest, supaConfigured, claimsOf, json } from "../../_lib/supa.js";
import { auditEvidence } from "../../_lib/evidence.js";
import { methodNotAllowed } from "../../_lib/http.js";

export async function onRequestPost({ request, env }) {
  if (!supaConfigured(env) || !env.DB) return json({ error: "verifier system not configured" }, 503);
  const user = await userFromRequest(request, env);
  if (!user) return json({ error: "sign in required" }, 401);
  const me = await verifierFor(env, user.id);
  if (!me) return json({ error: "not a verifier" }, 403);
  // Session 233 (Fix 1): an evidence decision needs an MFA-verified (aal2) session, before any database read.
  const aal = claimsOf(request).aal;
  if (aal !== "aal2") return json({ error: "Auditing evidence needs your authenticator app: verify first.", mfa: true }, 403);
  const states = me.role === "szv" ? [me.state_iso]
    : me.role === "nrv" ? (await rest(env, `region_states?region_id=eq.${encodeURIComponent(me.region_id)}&select=state_iso`)).map((r) => r.state_iso)
    : [];
  const body = await request.json().catch(() => ({}));
  const r = await auditEvidence(env.DB, body, { role: me.role, public_id: me.public_id, states, aal });
  return json(r.body, r.status);
}

// GET is not a read here: 405 instead of the site's 404 page (session 233, Fix 2; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
