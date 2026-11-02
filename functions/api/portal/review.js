// POST /api/portal/review {reportId, decision: "confirm"|"reject", note, controls?} — a signed-in SZV or NRV with an
// MFA-verified (aal2) session confirms or rejects one Form EC8A reading from their own state or region, after looking at
// the photo beside the transcript. Only confirmed readings count toward consensus (session 88). Numbers are never
// edited here. See functions/_lib/review.js. Reporter identities are never returned.
import { userFromRequest, verifierFor, rest, supaConfigured, claimsOf, json } from "../../_lib/supa.js";
import { reviewReading } from "../../_lib/review.js";
import { methodNotAllowed } from "../../_lib/http.js";

export async function onRequestPost({ request, env }) {
  if (!supaConfigured(env) || !env.DB) return json({ error: "verifier system not configured" }, 503);
  if (Number(request.headers.get("content-length") ?? 0) > 4096) return json({ error: "payload too large" }, 413);
  const user = await userFromRequest(request, env);
  if (!user) return json({ error: "sign in required" }, 401);
  const me = await verifierFor(env, user.id);
  if (!me) return json({ error: "not a verifier" }, 403);
  const states = me.role === "szv" ? [me.state_iso]
    : me.role === "nrv" ? (await rest(env, `region_states?region_id=eq.${encodeURIComponent(me.region_id)}&select=state_iso`)).map((r) => r.state_iso)
    : [];
  const body = await request.json().catch(() => ({}));
  const r = await reviewReading(env.DB, body, { role: me.role, public_id: me.public_id, states, aal: claimsOf(request).aal });
  if (r.status === 200) console.log(JSON.stringify({ event: "reading-reviewed", report: r.body.id, decision: r.body.decision, by: me.public_id }));
  return json(r.body, r.status);
}

// GET is not a read here: answer 405 instead of falling through to the home page (session 90; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
