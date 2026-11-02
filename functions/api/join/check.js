// POST /api/join/check { code } — does this invite code open a seat? Returns the seat (or, for an SZV / NRV code,
// every seat of that type in the invitee's area with open or taken) and the area only.
// Wrong codes are counted per hashed IP (10 per 15 minutes, then a cool-down).
import { supaConfigured, json } from "../../_lib/supa.js";
import { checkCode } from "../../_lib/invites.js";

const MSG = { invalid: "That code isn't valid or has expired.", rate_limited: "Too many attempts. Please wait 15 minutes and try again." };

export async function onRequestPost({ request, env }) {
  if (!supaConfigured(env) || !env.INVITE_PEPPER) return json({ error: "Joining is not switched on yet." }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const r = await checkCode(env, { code: String(b?.code ?? "").slice(0, 32), ip: request.headers.get("CF-Connecting-IP") });
  if (r.result !== "ok") return json({ error: MSG[r.result] ?? MSG.invalid }, r.result === "rate_limited" ? 429 : 404);
  return json({ ok: true, kind: r.kind, seat: r.seat_code, role: r.role, area: r.area, expiresAt: r.expires_at, seats: r.seats ?? [] });
}
