// POST /api/pipeline/ocr {reportId} — run the contained OCR on one report's processed photo (bots and processing
// workers, Bearer INGEST_TOKEN only; never the public). Off unless OCR_ENGINE = "workers-ai". A reading is only ever a
// proposal for a verifier to confirm; it never counts on its own. See functions/_lib/ocr.js and docs/protocol/OCR.md.
import { ocrReport } from "../../_lib/ocr.js";
import { assessControls } from "../../_lib/ec8a.js";
import { methodNotAllowed, sameSecret, unauthorised } from "../../_lib/http.js";

export async function onRequestPost({ request, env }) {
  // Session 233 (Fix 3): the shared constant-time comparison and the one fixed refusal (functions/_lib/http.js), so this
  // route answers exactly like every other closed intake route whether or not INGEST_TOKEN is set.
  if (!(await sameSecret(request.headers.get("authorization") ?? "", env.INGEST_TOKEN ? `Bearer ${env.INGEST_TOKEN}` : ""))) return unauthorised();
  if (!env.DB) return Response.json({ error: "database not bound" }, { status: 503 });
  const body = await request.json().catch(() => null);
  if (!/^[0-9a-f-]{36}$/.test(body?.reportId ?? "")) return Response.json({ error: "reportId (uuid) is required" }, { status: 422 });
  const r = await ocrReport(env, body.reportId, { assessControls });
  if (r.status === 200) console.log(JSON.stringify({ event: "ocr", report: r.body.id, result: r.body.ocr, filled: r.body.proposalFilled }));
  return Response.json(r.body, { status: r.status });
}

// GET is not a read here: answer 405 instead of falling through to the home page (session 90; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
