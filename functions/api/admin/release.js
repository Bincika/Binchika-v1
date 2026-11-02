// POST /api/admin/release { seat, reason } — BinchikAdmin + MFA only. Seats SZV-nnn, NRV-nn and OPS-1…3. Releases a held seat (or revokes its
// live invite): the holder is deactivated and banned from signing in, the public ID is retired, and an
// append-only seat event records the reason (the public history omits reasons).
import { requireAdmin, json } from "../../_lib/supa.js";
import { releaseSeat, dbMessage } from "../../_lib/invites.js";

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!/^(SZV-\d{3}|NRV-\d{2}|OPS-[1-3])$/.test(b?.seat ?? "") || String(b?.reason ?? "").trim().length < 10) {
    return json({ error: "seat and a reason of at least 10 characters are required" }, 422);
  }
  try {
    return json(await releaseSeat(env, { seat: b.seat, reason: String(b.reason).trim().slice(0, 500), actorUserId: gate.user.id }));
  } catch (e) {
    return json({ error: dbMessage(e) }, 409);
  }
}
