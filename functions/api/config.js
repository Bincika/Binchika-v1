// GET /api/config — public client config. Sign-in is enabled only when the publishable key is accepted by Supabase.
// Session 233 (closed-intake safety, Fix 8): a working answer is kept in the shared edge cache for five minutes, so a
// burst of page loads does not each call Supabase; a failing answer is never stored, so sign-in comes back as soon as
// Supabase does. The answer no longer says why sign-in is off (which secret is missing, or Supabase's status): that is
// shown only in the owner's Diagnostics.
import { readThroughCache } from "../_lib/edge-cache.js";

export const CONFIG_CACHE_SECONDS = 300;

async function buildConfig(env) {
  let signIn = false;
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    try {
      const r = await fetch(`${env.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: env.SUPABASE_ANON_KEY }, cf: { cacheTtl: 300 } });
      signIn = r.ok;
    } catch { /* signIn stays false */ }
  }
  const body = {
    supabaseUrl: env.SUPABASE_URL ?? null,
    publishableKey: signIn ? env.SUPABASE_ANON_KEY : null, // publishable keys are designed to be public
    signIn,
    // Session 88: no longer reports whether a service role is configured (a small disclosure; nothing used it).
  };
  const response = new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": signIn ? `public, max-age=${CONFIG_CACHE_SECONDS}` : "no-store",
    },
  });
  return { response, store: signIn };
}

export async function onRequestGet({ request, env, waitUntil }) {
  const origin = request ? new URL(request.url).origin : "https://binchika.internal";
  return readThroughCache({ key: new Request(`${origin}/api/config`), waitUntil, build: () => buildConfig(env) });
}
