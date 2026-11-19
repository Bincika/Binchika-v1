// POST /api/pipeline/unit {puCode, race} — re-run consensus for one unit (bots, OCR workers). Bearer INGEST_TOKEN.
import { processUnit } from "../../_lib/pipeline.js";
import { methodNotAllowed, sameSecret, unauthorised } from "../../_lib/http.js";

export async function onRequestPost({ request, env }) {
  // Session 233 (Fix 3): the shared constant-time comparison and the one fixed refusal (functions/_lib/http.js), so this
  // route answers exactly like every other closed intake route whether or not INGEST_TOKEN is set.
  if (!(await sameSecret(request.headers.get("authorization") ?? "", env.INGEST_TOKEN ? `Bearer ${env.INGEST_TOKEN}` : ""))) return unauthorised();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!/^\d{2}-\d{2}-\d{2}-\d{3}$/.test(body?.puCode ?? "") || !["president", "senate", "house", "governor", "state-assembly"].includes(body?.race)) {
    return Response.json({ error: "puCode (24-09-05-012) and race are required" }, { status: 422 });
  }
  const out = await processUnit(env.DB, body.puCode, body.race);
  return Response.json({ status: out.consensus.status, reports: out.consensus.reports, share: out.consensus.share, discrepancy: out.discrepancy, ledger: out.ledgerEntry ? { seq: out.ledgerEntry.seq, hash: out.ledgerEntry.hash } : null });
}

// GET is not a read here: 405 JSON with Allow: POST, not the site's 404 page (session 233, Fix 2; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
