// POST /api/reports — machine ingestion (bots, pipelines). Requires Bearer INGEST_TOKEN.
// GET  /api/reports — public aggregate counts only (no rows, no hashes).
import { parseReport, hashReporter, isLowerEvidence } from "../_lib/report.js";
import { assessControls } from "../_lib/ec8a.js";
import { sameSecret, unauthorised } from "../_lib/http.js";
import { RESULTS_CACHE_SECONDS, readThroughCache } from "../_lib/edge-cache.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// Session 152 (audit of 16 November 2026, docs/egm/audit-fixes/snapshot-only-read.md step A): the count is read through
// the shared edge cache, so anonymous requests cannot make the database scan the intake table each time. One fixed key:
// a query string cannot force a fresh read. A missing database or a failing query is answered but never stored.
export async function onRequestGet({ request, env, waitUntil }) {
  const key = new Request(`${new URL(request.url).origin}/api/reports`);
  return readThroughCache({ key, waitUntil, build: () => countReports(env) });
}

async function countReports(env) {
  if (!env.DB) return { response: json({ total: 0, byStatus: {}, note: "database not bound" }), store: false };
  let results;
  try { ({ results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM reports GROUP BY status").all()); }
  catch { console.log(JSON.stringify({ event: "report-count-failed" })); return { response: json({ error: "report counts temporarily unavailable" }, 503), store: false }; }
  const byStatus = Object.fromEntries(results.map((r) => [r.status, r.n]));
  const body = JSON.stringify({ total: results.reduce((a, r) => a + r.n, 0), byStatus });
  const response = new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${RESULTS_CACHE_SECONDS}` } });
  return { response, store: true };
}

export async function onRequestPost({ request, env }) {
  // Session 151: one refusal whether or not the token is set (functions/_lib/http.js). Only a caller holding the right
  // token is told that something else is missing.
  if (!(await sameSecret(request.headers.get("authorization") ?? "", env.INGEST_TOKEN ? `Bearer ${env.INGEST_TOKEN}` : ""))) return unauthorised();
  if (!env.REPORTER_HASH_SALT) return json({ error: "ingestion not configured" }, 503);
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
  // Session 88: the Form R1 control totals are checked on ingest and stored beside the report (numbers and reasons
  // only). A reading never counts until a verifier confirms it, and is never posted unless its sheet balances.
  let checks = null;
  if (v.tally || v.controls) {
    checks = assessControls(v.controls, v.tally);
    await env.DB.prepare("INSERT INTO report_checks (report_id, controls_json, checks_ok, checks_json) VALUES (?1, ?2, ?3, ?4)")
      .bind(id, v.controls ? JSON.stringify(v.controls) : null, checks.ok ? 1 : 0, checks.ok ? null : JSON.stringify(checks.errors)).run();
  }
  // Alternative evidence (no Form R1) waits for a verifier's audit and is marked lower-confidence (docs/EVIDENCE-AUDIT.md).
  return json({ id, status: "received", evidence: v.evidence, review: v.tally ? "a verifier must confirm this reading before it counts" : "waiting for a reading",
    ...(checks ? { controls: { balanced: checks.ok, problems: checks.errors } } : {}),
    ...(isLowerEvidence(v.evidence) ? { audit: "pending", confidence: "lower" } : {}) }, 201);
}
