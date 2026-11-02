// Sign-in links sent by Binchika itself (token-hash flow): the server asks Supabase Auth for a magic-link
// token, emails https://binchika.com/portal/#th=<hashed_token> from noreply@binchika.com, and the portal
// calls verifyOtp({ token_hash, type: "magiclink" }). No Supabase Site URL or redirect list is involved.
// Answers the same whether or not the email belongs to a verifier (no account enumeration).
import { rest } from "./supa.js";
import { sha256hex, sendEmail } from "./invites.js";
import { signInLink } from "./emails.js";

export async function sendSignInLink(env, { email, ip, reset = false }) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: "bad_email" };
  const pepper = env.INVITE_PEPPER;
  const verdict = await rest(env, "rpc/auth_link_check", { method: "POST", body: JSON.stringify({
    p_email: e, p_email_hash: await sha256hex(`link-email:${pepper}:${e}`), p_ip_hash: await sha256hex(`ip:${pepper}:${ip ?? "unknown"}`),
  }) });
  if (verdict === "rate_limited") return { error: "rate_limited" };
  if (verdict !== "ok") return { ok: true, sent: false };
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email: e }),
  });
  const j = await r.json().catch(() => ({}));
  const hashed = j.hashed_token ?? j.properties?.hashed_token;
  if (!r.ok || !hashed) return { error: "auth_error" };
  const link = `${env.SITE_URL ?? "https://binchika.com"}/portal/#th=${encodeURIComponent(hashed)}${reset ? "&reset=1" : ""}`;
  const sent = await sendEmail(env, e, signInLink({ link, reset }));
  return { ok: true, sent, link };   // link is for direct (test) callers only; the HTTP route never returns it
}
