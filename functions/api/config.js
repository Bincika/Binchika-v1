// GET /api/config — public client config. Sign-in is enabled only when the publishable key is accepted by Supabase.
import { json } from "../_lib/supa.js";

export async function onRequestGet({ env }) {
  let signIn = false, reason = "SUPABASE_ANON_KEY (publishable key) is not set";
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    try {
      const r = await fetch(`${env.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: env.SUPABASE_ANON_KEY }, cf: { cacheTtl: 300 } });
      signIn = r.ok;
      reason = r.ok ? null : `Supabase rejected the publishable key (HTTP ${r.status})`;
    } catch { reason = "Supabase unreachable"; }
  }
  return json({
    supabaseUrl: env.SUPABASE_URL ?? null,
    publishableKey: signIn ? env.SUPABASE_ANON_KEY : null, // publishable keys are designed to be public
    signIn,
    reason,
    // Session 88: no longer reports whether a service role is configured (a small disclosure; nothing used it).
  });
}
