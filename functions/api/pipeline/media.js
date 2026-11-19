// POST /api/pipeline/media?id=<reportId> — the evidence file for one report (raw bytes; Content-Type image/jpeg,
// image/png, image/webp or video/mp4). Bearer INGEST_TOKEN only: bots and processing workers, never the public, so
// intake stays closed. Removes location/camera metadata, checks for people, stores the result privately under R2 full/.
// See functions/_lib/photo.js and docs/PHOTO-PIPELINE.md.
import { processEvidence, MAX_VIDEO_BYTES } from "../../_lib/photo.js";
import { methodNotAllowed, sameSecret, unauthorised } from "../../_lib/http.js";

export async function onRequestPost({ request, env }) {
  // Session 233 (Fix 3): the shared constant-time comparison and the one fixed refusal (functions/_lib/http.js), so this
  // route answers exactly like every other closed intake route whether or not INGEST_TOKEN is set.
  if (!(await sameSecret(request.headers.get("authorization") ?? "", env.INGEST_TOKEN ? `Bearer ${env.INGEST_TOKEN}` : ""))) return unauthorised();
  if (Number(request.headers.get("content-length") ?? 0) > MAX_VIDEO_BYTES) return Response.json({ error: "file too large" }, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  const r = await processEvidence(env, { reportId: new URL(request.url).searchParams.get("id"), bytes, contentType: request.headers.get("content-type") });
  if (r.status === 200) console.log(JSON.stringify({ event: "evidence-processed", report: r.body.mediaRef.split("/").pop(), people: r.body.people, removed: r.body.removed.length }));
  return Response.json(r.body, { status: r.status });
}

// GET is not a read here: 405 JSON with Allow: POST, not the site's 404 page (session 233, Fix 2; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
