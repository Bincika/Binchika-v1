export async function onRequestGet({ env }) {
  let db = false;
  try { db = Boolean(env.DB && (await env.DB.prepare("SELECT 1 AS ok").first())?.ok === 1); } catch {}
  return new Response(JSON.stringify({ ok: true, db, ingest: Boolean(env.INGEST_TOKEN && env.REPORTER_HASH_SALT), telegram: Boolean(env.TELEGRAM_WEBHOOK_SECRET), evidence: Boolean(env.EVIDENCE), r2s3: Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_S3_ENDPOINT), time: new Date().toISOString() }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
