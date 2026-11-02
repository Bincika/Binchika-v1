// GET /api/seats — public seat board: code, area, taken/open. Never who holds a seat. Edge-cached 60 s.
import { rest, supaConfigured, json } from "../_lib/supa.js";

export async function onRequestGet({ env }) {
  if (!supaConfigured(env)) return json({ seats: [], note: "verifier system not configured" });
  try {
    const seats = await rest(env, "seat_board?select=code,role,state_iso,region_id,ordinal,label,taken,pending&order=role.desc,ordinal.asc");
    return new Response(JSON.stringify({ seats, updatedAt: new Date().toISOString() }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" } });
  } catch {
    return json({ seats: [], error: "seat board unavailable" }, 502);
  }
}
