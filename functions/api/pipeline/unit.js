// POST /api/pipeline/unit {puCode, race} — re-run consensus for one unit (bots, OCR workers). Bearer INGEST_TOKEN.
import { processUnit } from "../../_lib/pipeline.js";

async function authorised(request, env) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([request.headers.get("authorization") ?? "", `Bearer ${env.INGEST_TOKEN ?? ""}`].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = env.INGEST_TOKEN ? 0 : 1;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export async function onRequestPost({ request, env }) {
  if (!(await authorised(request, env))) return Response.json({ error: "unauthorised" }, { status: 401 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!/^\d{2}-\d{2}-\d{2}-\d{3}$/.test(body?.puCode ?? "") || !["president", "senate", "house", "governor", "state-assembly"].includes(body?.race)) {
    return Response.json({ error: "puCode (24-09-05-012) and race are required" }, { status: 422 });
  }
  const out = await processUnit(env.DB, body.puCode, body.race);
  return Response.json({ status: out.consensus.status, reports: out.consensus.reports, share: out.consensus.share, discrepancy: out.discrepancy, ledger: out.ledgerEntry ? { seq: out.ledgerEntry.seq, hash: out.ledgerEntry.hash } : null });
}
