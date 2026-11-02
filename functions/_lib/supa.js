// Minimal Supabase helpers for Pages Functions (no SDK): validate a user's access token and read
// verifier rows with the server-side secret key. Nothing here is exposed to the browser.

export function supaConfigured(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Returns the Supabase auth user for a bearer token, or null. */
export async function userFromRequest(request, env) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || !supaConfigured(env)) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}

export async function rest(env, path, init = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`supabase ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

export async function verifierFor(env, userId) {
  const rows = await rest(env, `verifiers?user_id=eq.${encodeURIComponent(userId)}&active=is.true&select=role,public_id,state_iso,region_id`);
  return rows?.[0] ?? null;
}

/**
 * The BinchikAdmin address lock (migration 0009): only an account whose lower-case email hashes to this value can
 * hold the BinchikAdmin role. The database enforces it; the API checks it again. The address itself is not stored.
 */
export const SUPERADMIN_EMAIL_SHA256 = "9387ed9432ec25ef93df84b8a0b9697ddef435a945e7f244670c4f79f88363e9";
export async function isLockedAdminEmail(email) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(email ?? "").trim().toLowerCase()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("") === SUPERADMIN_EMAIL_SHA256;
}

/** Claims of the (already validated) bearer token, e.g. aal = "aal2" after an MFA challenge. */
export function claimsOf(request) {
  try {
    const p = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").split(".")[1];
    return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return {}; }
}

/**
 * Admin gate for /api/admin/*: signed in, an active admin role, and an MFA-verified (aal2) session.
 * Returns { user, me } or a Response to send back. superOnly = BinchikAdmin (role key "superadmin", locked address).
 */
export async function requireAdmin(request, env, { superOnly = true } = {}) {
  if (!supaConfigured(env)) return json({ error: "not configured" }, 503);
  const user = await userFromRequest(request, env);
  if (!user) return json({ error: "sign in required" }, 401);
  const me = await verifierFor(env, user.id);
  if (!me || !(superOnly ? me.role === "superadmin" : ["admin", "superadmin"].includes(me.role))) return json({ error: superOnly ? "BinchikAdmin only" : "OpsAdmin or BinchikAdmin only" }, 403);
  if (me.role === "superadmin" && !(await isLockedAdminEmail(user.email))) return json({ error: "BinchikAdmin only" }, 403);
  if (claimsOf(request).aal !== "aal2") return json({ error: "MFA required: verify with your authenticator app first" }, 403);
  return { user, me };
}

export const json =(data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
