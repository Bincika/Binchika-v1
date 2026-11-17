// GET /api/health — public. Says only whether the service is up: { ok, time }.
// Session 150 (audit of 16 November 2026): it used to say which secrets and stores were configured. That detail now
// lives only in the owner's Diagnostics (/api/admin/diagnostics, BinchikAdmin + MFA). `ok` means the database answered;
// anything else is a 503, never a success by default.
export async function onRequestGet({ env }) {
  let ok = false;
  try { ok = Boolean(env.DB) && (await env.DB.prepare("SELECT 1 AS ok").first())?.ok === 1; } catch {}
  return new Response(JSON.stringify({ ok, time: new Date().toISOString() }), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
