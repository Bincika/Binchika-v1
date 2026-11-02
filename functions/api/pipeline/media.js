// POST /api/pipeline/media?id=<reportId> — the evidence file for one report (raw bytes; Content-Type image/jpeg,
// image/png, image/webp or video/mp4). Bearer INGEST_TOKEN only: bots and processing workers, never the public, so
// intake stays closed. Removes location/camera metadata, checks for people, stores the result privately under R2 full/.
// See functions/_lib/photo.js and docs/PHOTO-PIPELINE.md.
import { processEvidence, MAX_VIDEO_BYTES } from "../../_lib/photo.js";

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
  if (Number(request.headers.get("content-length") ?? 0) > MAX_VIDEO_BYTES) return Response.json({ error: "file too large" }, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  const r = await processEvidence(env, { reportId: new URL(request.url).searchParams.get("id"), bytes, contentType: request.headers.get("content-type") });
  if (r.status === 200) console.log(JSON.stringify({ event: "evidence-processed", report: r.body.mediaRef.split("/").pop(), people: r.body.people, removed: r.body.removed.length }));
  return Response.json(r.body, { status: r.status });
}
