// POST /api/join/claim { code, email, password, area, seat? } — claim a seat (seat = the one picked with an SZV / NRV code): the email must be the one applied with,
// the area must be the seat's state (SZV) or region (NRV). Creates the account, binds the seat (inactive)
// and emails the confirmation + pledge link from noreply@binchika.com. The link token is never returned here.
import { supaConfigured, json } from "../../_lib/supa.js";
import { claimSeat } from "../../_lib/invites.js";

const MSG = {
  invalid: "That code isn't valid or has expired.",
  rate_limited: "Too many attempts. Please wait 15 minutes and try again.",
  email_mismatch: "That isn't the email address on the application this code was sent for.",
  area_mismatch: "That isn't the state or region of this seat. Verifiers can only serve the area they applied for.",
  account_exists: "An account already exists for this email. Please contact us.",
  bad_email: "Please enter a valid email address.",
  seat_required: "Please choose one of the open seats.",
  seat_unavailable: "That seat has just been taken. Please choose another open seat.",
  reserved_email: "That address can't claim a verifier seat.",
};

export async function onRequestPost({ request, env }) {
  if (!supaConfigured(env) || !env.INVITE_PEPPER) return json({ error: "Joining is not switched on yet." }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const r = await claimSeat(env, {
    code: String(b?.code ?? "").slice(0, 32), email: String(b?.email ?? "").slice(0, 254), password: b?.password,
    area: String(b?.area ?? "").slice(0, 8), ip: request.headers.get("CF-Connecting-IP"),
    seat: /^(SZV-\d{3}|NRV-\d{2})$/.test(b?.seat ?? "") ? b.seat : null,
  });
  if (r.error) return json({ error: r.message ?? MSG[r.error] ?? "Something went wrong. Please try again." }, r.error === "rate_limited" ? 429 : 422);
  return json({ ok: true, seat: r.seat, publicId: r.publicId, area: r.area, emailed: r.emailed });
}
