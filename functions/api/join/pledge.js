// POST /api/join/pledge { token }                                  → the pledge text for this confirmation link
// POST /api/join/pledge { token, typedName, version, accept: true } → sign: confirms the email, activates the seat
import { supaConfigured, json } from "../../_lib/supa.js";
import { pledgePreview, signPledge } from "../../_lib/invites.js";

const MSG = {
  invalid: "This link has been used or has expired.",
  name_mismatch: "Please type your full name exactly as on your application (accents and capitals don't matter).",
  not_accepted: "Please tick the box to accept the pledge.",
  unknown_version: "The pledge wording has changed. Please reload the page.",
};

export async function onRequestPost({ request, env }) {
  if (!supaConfigured(env) || !env.INVITE_PEPPER) return json({ error: "Joining is not switched on yet." }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const token = String(b?.token ?? "");
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return json({ error: MSG.invalid }, 404);
  if (b.typedName === undefined) {
    const p = await pledgePreview(env, { token });
    return p ? json({ ok: true, seat: p.seat_code, publicId: p.public_id, area: p.area, version: p.version, body: p.body, sha256: p.sha256 }) : json({ error: MSG.invalid }, 404);
  }
  const r = await signPledge(env, { token, typedName: b.typedName, version: String(b.version ?? ""), accept: b.accept });
  if (r.error) return json({ error: MSG[r.error] ?? MSG.invalid }, r.error === "invalid" ? 404 : 422);
  return json({ ok: true, seat: r.seat, publicId: r.publicId, emailed: r.emailed });
}
