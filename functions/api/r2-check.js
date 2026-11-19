// POST /api/r2-check — operator-only R2 smoke test (Bearer INGEST_TOKEN). Writes one tiny object under tmp/
// (which the bucket's lifecycle rule deletes after 7 days anyway), reads it back, deletes it and confirms it is
// gone. No photo, no personal data; it does not open photo intake. Run with: node scripts/r2-check.mjs [base]
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

import { sameSecret, unauthorised, methodNotAllowed } from "../_lib/http.js";

export async function onRequestPost({ request, env }) {
  // Session 151: one refusal whether or not the token is set (functions/_lib/http.js).
  if (!(await sameSecret(request.headers.get("authorization") ?? "", env.INGEST_TOKEN ? `Bearer ${env.INGEST_TOKEN}` : ""))) return unauthorised();
  if (!env.EVIDENCE) return json({ ok: false, bound: false, error: "EVIDENCE binding missing" }, 500);
  const key = `tmp/healthcheck/${crypto.randomUUID()}.txt`;
  const body = `binchika r2 check ${new Date().toISOString()}`;
  const steps = { bound: true, key };
  const t0 = Date.now();
  try {
    const put = await env.EVIDENCE.put(key, body, { httpMetadata: { contentType: "text/plain" }, customMetadata: { purpose: "healthcheck" } });
    steps.put = Boolean(put?.etag);
    const got = await env.EVIDENCE.get(key);
    steps.readBack = got ? (await got.text()) === body : false;
    await env.EVIDENCE.delete(key);
    steps.deleted = (await env.EVIDENCE.head(key)) === null;
  } catch (e) {
    steps.error = String(e?.message ?? e).slice(0, 200);
    await env.EVIDENCE.delete(key).catch(() => {});
  }
  steps.ms = Date.now() - t0;
  steps.ok = Boolean(steps.put && steps.readBack && steps.deleted);
  return json(steps, steps.ok ? 200 : 500);
}

// GET is not a read here: 405 JSON with Allow: POST, not the site's 404 page (session 233, Fix 2; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
