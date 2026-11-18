// GET /api/admin/correction-conflicts — BinchikAdmin + MFA only (build plan 8, section 5.4). Read-only.
// Lists (a) open conflicts: a later recount that disagrees with a standing correction, which a person must decide through
// the normal three-seat flag chain; and (b) unreconciled claims: a correction written to the ledger whose flag in Supabase
// is not marked approved. Admins only by owner decision D2: nothing here reaches a public page or feed.
// Nothing is read before the gate passes. No person is named: units, races, hashes, times and flag ids only.
// Until the migration exists (previews share the production database) the route answers 503 and reads nothing more.
import { requireAdmin, rest, json } from "../../_lib/supa.js";
import { guardReady } from "../../_lib/correction-guard.js";

export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);   // BinchikAdmin + MFA (aal2)
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "not configured" }, 503);
  if (!(await guardReady(env.DB))) return json({ error: "corrections are being upgraded; this list is not available yet" }, 503);
  try {
    const { results: open } = await env.DB.prepare(
      `SELECT id, pu_code, race, correction_hash, recomputed_status, recomputed_json, detected_at
         FROM correction_conflicts WHERE resolved_at IS NULL ORDER BY detected_at LIMIT 500`,
    ).all();
    const { results: claims } = await env.DB.prepare(
      "SELECT flag_id, pu_code, race, ledger_hash, created_at FROM correction_claims ORDER BY created_at DESC LIMIT 500",
    ).all();
    const ids = claims.map((c) => c.flag_id).filter((id) => /^[0-9a-f-]{36}$/.test(id));
    const flags = ids.length ? await rest(env, `discrepancy_flags?id=in.(${ids.join(",")})&select=id,status`) : [];
    const status = new Map((flags ?? []).map((f) => [f.id, f.status]));
    const unreconciled = claims
      .filter((c) => status.get(c.flag_id) !== "approved")
      .map((c) => ({ flag_id: c.flag_id, pu_code: c.pu_code, race: c.race, ledger_hash: c.ledger_hash, created_at: c.created_at, flag_status: status.get(c.flag_id) ?? null }));
    const conflicts = open.map((c) => ({ ...c, recomputed: c.recomputed_json ? JSON.parse(c.recomputed_json) : null, recomputed_json: undefined }));
    return json({ conflicts, unreconciled });
  } catch {
    return json({ error: "The list could not be read." }, 502);
  }
}

export function onRequestPost() {
  return new Response(JSON.stringify({ error: "method not allowed", allow: "GET" }), { status: 405, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", allow: "GET" } });
}
