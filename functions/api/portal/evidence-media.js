// GET /api/portal/evidence-media?id=<reportId> — the stored photo or video for one report, for a signed-in SZV/NRV
// with an MFA-verified (aal2) session, from their own state or region only. Never public, never cached, never
// framed; the reporter's identity is never included. See functions/_lib/evidence.js and docs/EVIDENCE-AUDIT.md.
import { userFromRequest, verifierFor, rest, supaConfigured, claimsOf, json } from "../../_lib/supa.js";
import { evidenceMedia } from "../../_lib/evidence.js";

export async function onRequestGet({ request, env }) {
  if (!supaConfigured(env) || !env.DB) return json({ error: "verifier system not configured" }, 503);
  const user = await userFromRequest(request, env);
  if (!user) return json({ error: "sign in required" }, 401);
  const me = await verifierFor(env, user.id);
  if (!me) return json({ error: "not a verifier" }, 403);
  const states = me.role === "szv" ? [me.state_iso]
    : me.role === "nrv" ? (await rest(env, `region_states?region_id=eq.${encodeURIComponent(me.region_id)}&select=state_iso`)).map((r) => r.state_iso)
    : [];
  const id = new URL(request.url).searchParams.get("id");
  const r = await evidenceMedia(env.DB, env.EVIDENCE, id, { role: me.role, public_id: me.public_id, states, aal: claimsOf(request).aal });
  if (r.status !== 200) return json(r.body, r.status);
  console.log(JSON.stringify({ event: "evidence-viewed", report: r.report.id, by: me.public_id }));
  const ext = r.type.split("/")[1];
  return new Response(r.object.body, {
    headers: {
      "content-type": r.type,
      "content-length": String(r.object.size),
      "content-disposition": `inline; filename="evidence-${r.report.id}.${ext}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-evidence-sha256": r.report.media_sha256 ?? "",
      "x-evidence-people": r.report.face_check ?? "unchecked",
    },
  });
}
