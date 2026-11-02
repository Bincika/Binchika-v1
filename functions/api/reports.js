// POST /api/reports — machine ingestion (bots, pipelines). Requires Bearer INGEST_TOKEN.
// GET  /api/reports — public aggregate counts only (no rows, no hashes).
import { parseReport, hashReporter, isLowerEvidence } from "../_lib/report.js";
import { assessControls } from "../_lib/ec8a.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s ?? ""))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ total: 0, byStatus: {}, note: "database not bound" });
  const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM reports GROUP BY status").all();
  const byStatus = Object.fromEntries(results.map((r) => [r.status, r.n]));
  return json({ total: results.reduce((a, r) => a + r.n, 0), byStatus });
}

export async function onRequestPost({ request, env }) {
  if (!env.INGEST_TOKEN || !env.REPORTER_HASH_SALT) return json({ error: "ingestion not configured" }, 503);
  const auth = request.headers.get("authorization") ?? "";
  if (!(await safeEqual(auth, `Bearer ${env.INGEST_TOKEN}`))) return json({ error: "unauthorised" }, 401);
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) return json({ error: "payload too large" }, 413);

  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const parsed = parseReport(body);
  if (!parsed.ok) return json({ errors: parsed.errors }, 422);

  const v = parsed.value;
  const id = crypto.randomUUID();
  const reporterHash = await hashReporter(env.REPORTER_HASH_SALT, v.channel, v.handle);
  await env.DB.prepare(
    `INSERT INTO reports (id, channel, reporter_hash, pu_code, race, media_ref, media_sha256, caption, tally_json, status, evidence, audit_status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
  ).bind(id, v.channel, reporterHash, v.puCode, v.race, v.mediaRef, v.mediaSha256, v.caption, v.tally ? JSON.stringify(v.tally) : null, v.tally ? "needs_review" : "ocr_pending",
    v.evidence, isLowerEvidence(v.evidence) ? "pending" : null).run();
  // Session 88: the Form EC8A control totals are checked on ingest and stored beside the report (numbers and reasons
  // only). A reading never counts until a verifier confirms it, and is never posted unless its sheet balances.
  let checks = null;
  if (v.tally || v.controls) {
    checks = assessControls(v.controls, v.tally);
    await env.DB.prepare("INSERT INTO report_checks (report_id, controls_json, checks_ok, checks_json) VALUES (?1, ?2, ?3, ?4)")
      .bind(id, v.controls ? JSON.stringify(v.controls) : null, checks.ok ? 1 : 0, checks.ok ? null : JSON.stringify(checks.errors)).run();
  }
  // Alternative evidence (no Form EC8A) waits for a verifier's audit and is marked lower-confidence (docs/EVIDENCE-AUDIT.md).
  return json({ id, status: "received", evidence: v.evidence, review: v.tally ? "a verifier must confirm this reading before it counts" : "waiting for a reading",
    ...(checks ? { controls: { balanced: checks.ok, problems: checks.errors } } : {}),
    ...(isLowerEvidence(v.evidence) ? { audit: "pending", confidence: "lower" } : {}) }, 201);
}
