// POST /api/auth/link { email, reset? } — email a one-time sign-in link from noreply@binchika.com.
// Always the same answer whether or not the address has an account; 3 per email / 10 per IP per 15 minutes.
import { supaConfigured, json } from "../../_lib/supa.js";
import { sendSignInLink } from "../../_lib/authlink.js";

const SAME = "If that email belongs to an active verifier, a sign-in link is on its way. It works once.";

export async function onRequestPost({ request, env }) {
  if (!supaConfigured(env) || !env.INVITE_PEPPER || !env.RESEND_API_KEY) return json({ error: "Sign-in links are not switched on yet." }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const r = await sendSignInLink(env, { email: String(b?.email ?? "").slice(0, 254), reset: b?.reset === true, ip: request.headers.get("CF-Connecting-IP") });
  if (r.error === "bad_email") return json({ error: "Please enter a valid email address." }, 422);
  if (r.error === "rate_limited") return json({ error: "Too many requests. Please wait 15 minutes and try again." }, 429);
  if (r.error) return json({ error: "Could not send a link just now. Please try again shortly." }, 502);
  return json({ ok: true, message: SAME });
}
