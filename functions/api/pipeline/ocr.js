// POST /api/pipeline/ocr {reportId} — run the contained OCR on one report's processed photo (bots and processing
// workers, Bearer INGEST_TOKEN only; never the public). Off unless OCR_ENGINE = "workers-ai". A reading is only ever a
// proposal for a verifier to confirm; it never counts on its own. See functions/_lib/ocr.js and docs/protocol/OCR.md.
import { ocrReport } from "../../_lib/ocr.js";
import { assessControls } from "../../_lib/ec8a.js";
import { methodNotAllowed } from "../../_lib/http.js";

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
  if (!env.DB) return Response.json({ error: "database not bound" }, { status: 503 });
  const body = await request.json().catch(() => null);
  if (!/^[0-9a-f-]{36}$/.test(body?.reportId ?? "")) return Response.json({ error: "reportId (uuid) is required" }, { status: 422 });
  const r = await ocrReport(env, body.reportId, { assessControls });
  if (r.status === 200) console.log(JSON.stringify({ event: "ocr", report: r.body.id, result: r.body.ocr, filled: r.body.proposalFilled }));
  return Response.json(r.body, { status: r.status });
}

// GET is not a read here: answer 405 instead of falling through to the home page (session 90; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
