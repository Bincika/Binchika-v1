// Retention for the verifier database and evidence photos (session 63; docs/RETENTION.md). Runs every third day with
// the keep-alive ping. Each part fails safe: a missing or invalid setting skips it (nothing is deleted), and an error in
// one part never stops the other or the ping. Logs carry counts only, never public IDs, names or addresses.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MIN_APPLICATION_DAYS = 30;
export const PHOTO_PAGE = 500;
export const PHOTO_MAX_PER_RUN = 5000;
const dryRun = (env) => String(env.RETENTION_DRY_RUN ?? "").trim().toLowerCase() === "true";

/** Applications and former seat holders, through Supabase's retention_purge() (migration 0011, service role only). */
export async function purgeVerifierData(env, now = new Date()) {
  const days = Number(String(env.APPLICATION_RETENTION_DAYS ?? "").trim());
  const months = Number(String(env.SEAT_HOLDER_RETENTION_MONTHS ?? "").trim());
  const gov = String(env.GOVERNORSHIP_FINAL_RESULTS ?? "").trim();
  if (!Number.isInteger(days) || days < MIN_APPLICATION_DAYS || !Number.isInteger(months) || months < 1) return { skipped: "invalid retention settings" };
  if (gov && !DATE.test(gov)) return { skipped: "invalid GOVERNORSHIP_FINAL_RESULTS (use YYYY-MM-DD, or leave empty until INEC declares)" };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: "not configured" };
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/retention_purge`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ p_now: now.toISOString(), p_governorship_final: gov || null, p_application_days: days, p_holder_months: months, p_dry_run: dryRun(env) }),
  });
  const b = await r.json().catch(() => null);
  if (!r.ok || !b) throw new Error(`retention_purge failed: ${r.status}`);
  return { dryRun: b.dry_run, applicationsDue: b.applications_due, applications: b.applications, seatHolders: b.seat_holders, unpledgedAccounts: b.unpledged_accounts, pledges: b.pledges };
}

/**
 * Result-sheet photos and videos: from PHOTO_DELETE_FROM (12 months after the last 2027 election day), every processed
 * file under R2 full/ is deleted and its report marked "deleted:<date>", so the evidence viewer shows it is gone.
 */
export async function purgePhotos(env, now = new Date()) {
  const from = String(env.PHOTO_DELETE_FROM ?? "").trim();
  if (!DATE.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`))) return { skipped: "invalid PHOTO_DELETE_FROM" };
  if (now < new Date(`${from}T00:00:00Z`)) return { skipped: `not before ${from}` };
  if (!env.EVIDENCE || !env.DB) return { skipped: "not configured" };
  const dry = dryRun(env), stamp = `deleted:${now.toISOString().slice(0, 10)}`;
  // Deleting: always list again from the start, because deleted files drop out of the listing. Dry run: follow the cursor.
  let photos = 0, more = false, cursor;
  for (;;) {
    const page = await env.EVIDENCE.list({ prefix: "full/", limit: PHOTO_PAGE, ...(dry && cursor ? { cursor } : {}) });
    const keys = (page.objects ?? []).map((o) => o.key).filter((k) => k.startsWith("full/"));
    if (keys.length && !dry) {
      await env.EVIDENCE.delete(keys);
      await env.DB.batch(keys.map((k) => env.DB.prepare("UPDATE reports SET media_ref = ?2 WHERE media_ref = ?1").bind(`r2:${k}`, stamp)));
    }
    photos += keys.length;
    more = Boolean(page.truncated);
    if (!more || !keys.length) break;
    if (photos >= PHOTO_MAX_PER_RUN) break;                              // the rest waits for the next run
    cursor = page.cursor;
  }
  return { dryRun: dry, photos, more };
}

/** Both parts, logged separately; never throws. */
export async function runRetention(env, now = new Date()) {
  const out = {};
  for (const [part, fn] of [["verifier-data", purgeVerifierData], ["photos", purgePhotos]]) {
    try { out[part] = await fn(env, now); console.log(JSON.stringify({ event: "retention", part, ...out[part] })); }
    catch (e) { out[part] = { error: String(e).slice(0, 160) }; console.log(JSON.stringify({ event: "retention-failed", part, error: out[part].error })); }
  }
  return out;
}
