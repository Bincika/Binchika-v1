// /api/admin/applications — BinchikAdmin + MFA only (session 134).
// GET: applications stored for human review (status 'submitted'), without names, emails or card data.
// POST { action: "approve" | "reject" | "request_info", applicationId }: decide or ask the applicant one question.
// The eligible list and the invite flow stay in /api/admin/invites, unchanged. Logic: functions/_lib/appreview.js.
import { requireAdmin, json } from "../../_lib/supa.js";
import { listForReview, reviewAction } from "../../_lib/appreview.js";

export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  try { return json(await listForReview(env)); } catch { return json({ error: "Could not load applications for review." }, 502); }
}

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const meta = async () => (await fetch(new URL("/data/states.json", request.url))).json();
  try {
    const r = await reviewAction(env, { action: b?.action, applicationId: b?.applicationId, actor: gate.me.public_id }, { meta });
    return json(r.body, r.status);
  } catch {
    return json({ error: "The database refused the change. Nothing was sent." }, 502);
  }
}
