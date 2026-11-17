// GET /api/admin/diagnostics — BinchikAdmin + MFA only (session 143). Read-only: which bindings and secrets are set
// (true or false, never a value), the public switches, whether the database and Supabase answer, and whether the Android
// app link file is in place. Nothing is read before the gate passes; nothing is stored or logged.
// Logic: functions/_lib/diagnostics.js.
import { requireAdmin, json } from "../../_lib/supa.js";
import { collect } from "../../_lib/diagnostics.js";

export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  try {
    // ASSETS serves the static file directly, so this cannot re-enter a Function.
    const readAssetLinks = env.ASSETS ? () => env.ASSETS.fetch(new URL("/.well-known/assetlinks.json", request.url)) : undefined;
    return json(await collect(env, { readAssetLinks }));
  } catch {
    return json({ error: "Diagnostics could not be read." }, 502);
  }
}

export function onRequestPost() {
  return new Response(JSON.stringify({ error: "method not allowed", allow: "GET" }), { status: 405, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", allow: "GET" } });
}
