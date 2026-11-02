// GET /api/ledger?after=<seq>&limit=<n> — public ledger entries (append-only, hash-chained).
import { TENANT } from "../_lib/tenant.generated.js";   // body name (session 98)
import { ledgerHead, CYCLE } from "../_lib/pipeline.js";
import { genesis } from "../_lib/ledger.js";

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const after = Math.max(0, Number(u.searchParams.get("after") ?? 0) | 0);
  const limit = Math.min(1000, Math.max(1, Number(u.searchParams.get("limit") ?? 500) | 0));
  const g = await genesis(CYCLE);
  if (!env.DB) return Response.json({ cycle: CYCLE, genesis: g, head: g, count: 0, entries: [] });
  const [{ results }, head, total] = await Promise.all([
    env.DB.prepare("SELECT body_json, hash FROM ledger_entries WHERE seq > ?1 ORDER BY seq LIMIT ?2").bind(after, limit).all(),
    ledgerHead(env.DB),
    env.DB.prepare("SELECT COUNT(*) AS n FROM ledger_entries").first(),
  ]);
  return Response.json({
    cycle: CYCLE, genesis: g, head: head.hash, count: total?.n ?? 0,
    entries: results.map((r) => ({ ...JSON.parse(r.body_json), hash: r.hash })),
    notice: `Citizen-verified tallies. Not official results. Only ${TENANT.electoralBody.short} declares results.`,
  }, { headers: { "cache-control": "public, max-age=10" } });
}
