// POST /api/admin/ops { seat: "OPS-1"|"OPS-2"|"OPS-3", email } — BinchikAdmin + MFA only. Appoints an OpsAdmin
// to one of the three OpsAdmin seats. OpsAdmins are never created by invite code or application, can never become
// BinchikAdmin (database trigger + lock), and must use MFA before any admin power works.
import { requireAdmin, json } from "../../_lib/supa.js";
import { appointOps } from "../../_lib/invites.js";

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const r = await appointOps(env, { seat: String(b?.seat ?? ""), email: String(b?.email ?? "").slice(0, 254), actorUserId: gate.user.id });
  if (r.error) return json({ error: r.error }, 409);
  const { userId, ...out } = r;
  return json({ ...out, note: r.emailed ? `${r.seat} appointed as ${r.publicId}. A sign-in link was emailed to the appointee.` : `${r.seat} appointed as ${r.publicId}, but the email failed: ask them to use "Email me a sign-in link" on the portal.` });
}
